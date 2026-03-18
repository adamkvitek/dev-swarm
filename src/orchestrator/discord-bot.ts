import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  EmbedBuilder,
} from "discord.js";
import { Pipeline, type PipelineEvent } from "./pipeline.js";
import type { TaskPlan } from "../agents/cto.js";
import type { Env } from "../config/env.js";

type SessionState =
  | { phase: "idle" }
  | { phase: "clarifying"; pipeline: Pipeline }
  | { phase: "awaiting_approval"; pipeline: Pipeline; plan: TaskPlan }
  | { phase: "executing"; pipeline: Pipeline };

export class DiscordBot {
  private client: Client;
  private env: Env;
  private sessions: Map<string, SessionState> = new Map();

  constructor(env: Env) {
    this.env = env;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel],
    });

    // Debug: log ALL raw gateway events
    this.client.on("raw", (event: { t: string }) => {
      if (event.t === "MESSAGE_CREATE") {
        console.log(`[RAW] MESSAGE_CREATE event received`);
      }
    });

    this.client.on("ready", () => {
      console.log(`Bot logged in as ${this.client.user?.tag}`);
      console.log(`Connected to ${this.client.guilds.cache.size} server(s):`);
      for (const guild of this.client.guilds.cache.values()) {
        console.log(`  - ${guild.name} (${guild.id})`);
        for (const channel of guild.channels.cache.values()) {
          if (channel.isTextBased() && "name" in channel) {
            console.log(`    #${channel.name} (${channel.id})`);
          }
        }
      }
    });

    this.client.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });
  }

  async start(): Promise<void> {
    await this.client.login(this.env.DISCORD_BOT_TOKEN);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  private getSession(channelId: string): SessionState {
    return this.sessions.get(channelId) ?? { phase: "idle" };
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;

    // Only respond to mentions or messages starting with !dev
    const isMention = message.mentions.has(this.client.user!);
    const isCommand = message.content.startsWith("!dev");

    console.log(`[MSG] ${message.author.tag}: "${message.content}" | mention=${isMention} cmd=${isCommand}`);

    if (!isMention && !isCommand) return;

    const content = message.content
      .replace(`<@${this.client.user!.id}>`, "")
      .replace("!dev", "")
      .trim();

    console.log(`[CMD] Processing: "${content}"`);

    const channel = message.channel as TextChannel;
    const session = this.getSession(channel.id);

    try {
      if (content.toLowerCase() === "cancel") {
        this.sessions.set(channel.id, { phase: "idle" });
        await channel.send("Session cancelled. Ready for a new task.");
        return;
      }

      if (content.toLowerCase() === "approve" && session.phase === "awaiting_approval") {
        this.sessions.set(channel.id, {
          phase: "executing",
          pipeline: session.pipeline,
        });
        await channel.send("Plan approved. Starting workers...");
        await session.pipeline.executePlan(session.plan);
        return;
      }

      if (session.phase === "clarifying") {
        await session.pipeline.continueWithAnswers(content);
        return;
      }

      // New task
      console.log(`[NEW] Starting new task pipeline...`);
      await channel.send(`Got it! Analyzing your request...`);

      const pipeline = new Pipeline(this.env, (event) =>
        this.handlePipelineEvent(channel, event)
      );

      this.sessions.set(channel.id, { phase: "clarifying", pipeline });
      console.log(`[NEW] Calling pipeline.start()...`);
      await pipeline.start(content);
      console.log(`[NEW] pipeline.start() completed`);
    } catch (error) {
      console.error(`[ERR]`, error);
      const errMsg = error instanceof Error ? error.message : String(error);
      await channel.send(`Error: ${errMsg}`);
      this.sessions.set(channel.id, { phase: "idle" });
    }
  }

  private async handlePipelineEvent(
    channel: TextChannel,
    event: PipelineEvent
  ): Promise<void> {
    switch (event.type) {
      case "clarification": {
        const questions = event.questions
          .map((q, i) => `${i + 1}. ${q}`)
          .join("\n");
        await channel.send(
          `**Before I start, I need some clarification:**\n${questions}\n\n_Reply with your answers._`
        );
        break;
      }

      case "plan": {
        const subtaskLines = event.plan.subtasks
          .map((s, i) => `**${i + 1}. ${s.title}**\n${s.description}`)
          .join("\n\n");

        // Discord embed fields max 1024 chars, description max 4096
        const truncate = (s: string, max: number): string =>
          s.length <= max ? s : s.slice(0, max - 3) + "...";

        const embed = new EmbedBuilder()
          .setTitle("Task Plan")
          .setDescription(truncate(event.plan.summary, 4096))
          .addFields(
            {
              name: "Tech Stack",
              value: truncate(event.plan.techStack.join(", ") || "TBD", 1024),
            },
            {
              name: "Decisions",
              value: truncate(event.plan.decisions.join("\n") || "None yet", 1024),
            }
          )
          .setColor(0x5865f2)
          .setFooter({ text: 'Reply "approve" to start or provide feedback.' });

        await channel.send({ embeds: [embed] });

        // Send subtasks as follow-up messages (can be long)
        const chunks: string[] = [];
        let current = "**Subtasks:**\n\n";
        for (const line of subtaskLines.split("\n\n")) {
          if (current.length + line.length + 2 > 1900) {
            chunks.push(current);
            current = "";
          }
          current += line + "\n\n";
        }
        if (current.trim()) chunks.push(current);

        for (const chunk of chunks) {
          await channel.send(chunk);
        }

        // Update session to awaiting_approval
        const session = this.getSession(channel.id);
        if (session.phase === "clarifying") {
          this.sessions.set(channel.id, {
            phase: "awaiting_approval",
            pipeline: session.pipeline,
            plan: event.plan,
          });
        }
        break;
      }

      case "iteration":
        await channel.send(
          `**Iteration ${event.current}/${event.max}**`
        );
        break;

      case "workers_started":
        await channel.send(
          `Dispatching ${event.subtaskCount} worker(s)...`
        );
        break;

      case "workers_completed": {
        const completed = event.results.filter(
          (r) => r.status === "completed"
        ).length;
        const blocked = event.results.filter(
          (r) => r.status === "blocked"
        ).length;
        await channel.send(
          `Workers done: ${completed} completed, ${blocked} blocked. Sending to reviewer...`
        );
        break;
      }

      case "review_completed": {
        const { scores, feedback, verdict } = event.review;
        const embed = new EmbedBuilder()
          .setTitle(`Review — ${verdict}`)
          .setDescription(feedback)
          .addFields(
            {
              name: "Scores",
              value: [
                `Correctness: ${scores.correctness}/10`,
                `Code Quality: ${scores.codeQuality}/10`,
                `Test Coverage: ${scores.testCoverage}/10`,
                `Security: ${scores.security}/10`,
                `Completeness: ${scores.completeness}/10`,
                `**Average: ${scores.average.toFixed(1)}/10**`,
              ].join("\n"),
            }
          )
          .setColor(verdict === "APPROVE" ? 0x57f287 : 0xed4245);

        await channel.send({ embeds: [embed] });
        break;
      }

      case "approved":
        await channel.send(
          `**Task complete!** Approved after ${event.finalReview.iteration} iteration(s) with average score ${event.finalReview.scores.average.toFixed(1)}/10.`
        );
        this.sessions.set(channel.id, { phase: "idle" });
        break;

      case "max_iterations_reached":
        await channel.send(
          `**Max iterations reached.** Best score: ${event.lastReview.scores.average.toFixed(1)}/10. Delivering current output.`
        );
        this.sessions.set(channel.id, { phase: "idle" });
        break;

      case "error":
        await channel.send(`Pipeline error: ${event.message}`);
        this.sessions.set(channel.id, { phase: "idle" });
        break;
    }
  }
}
