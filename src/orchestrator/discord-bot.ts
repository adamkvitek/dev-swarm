import {
  Client,
  GatewayIntentBits,
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
    });

    this.client.on("ready", () => {
      console.log(`Bot logged in as ${this.client.user?.tag}`);
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

    if (!isMention && !isCommand) return;

    const content = message.content
      .replace(`<@${this.client.user!.id}>`, "")
      .replace("!dev", "")
      .trim();

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
      const pipeline = new Pipeline(this.env, (event) =>
        this.handlePipelineEvent(channel, event)
      );

      this.sessions.set(channel.id, { phase: "clarifying", pipeline });
      await pipeline.start(content);
    } catch (error) {
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
        const subtasks = event.plan.subtasks
          .map((s) => `- **${s.title}**: ${s.description}`)
          .join("\n");

        const embed = new EmbedBuilder()
          .setTitle("Task Plan")
          .setDescription(event.plan.summary)
          .addFields(
            { name: "Subtasks", value: subtasks || "None" },
            {
              name: "Tech Stack",
              value: event.plan.techStack.join(", ") || "TBD",
            },
            {
              name: "Decisions",
              value: event.plan.decisions.join("\n") || "None yet",
            }
          )
          .setColor(0x5865f2)
          .setFooter({ text: 'Reply "approve" to start or provide feedback.' });

        await channel.send({ embeds: [embed] });

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
