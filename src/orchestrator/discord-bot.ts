import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  EmbedBuilder,
} from "discord.js";
import { Pipeline, type PipelineEvent } from "./pipeline.js";
import { ClaudeSession } from "../agents/claude-session.js";
import type { TaskPlan } from "../agents/cto.js";
import type { Env } from "../config/env.js";

type SessionState =
  | { phase: "idle" }
  | { phase: "clarifying"; pipeline: Pipeline }
  | { phase: "awaiting_approval"; pipeline: Pipeline; plan: TaskPlan }
  | { phase: "executing"; pipeline: Pipeline };

/**
 * Uses Claude to classify user intent — no hardcoded keywords.
 */
async function classifyIntent(
  classifierSession: ClaudeSession,
  userMessage: string,
  sessionPhase: string
): Promise<{ intent: "new_task" | "approve" | "cancel" | "clarification_answer" | "chat"; task?: string }> {
  const prompt = `Classify intent. Session: ${sessionPhase}. Message: "${userMessage.slice(0, 500)}"
Rules:
- approve = message contains ANY approval (even with additional feedback/instructions). If user says "approved" or "go ahead" ANYWHERE in the message, it's approve even if they also give feedback.
- cancel = user explicitly wants to stop/cancel
- clarification_answer = ONLY when session=clarifying AND message is purely answering questions
- new_task = user wants new development work (no active session, or explicitly new request)
- chat = greeting, status question, casual
IMPORTANT: If session=awaiting_approval and message contains approval words, ALWAYS return approve.
JSON only: {"intent": "...", "task": "...if new_task"}`;

  try {
    const result = await classifierSession.send(prompt, { timeoutMs: 60_000 });
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) return { intent: "new_task", task: userMessage };
    return JSON.parse(match[0]) as { intent: "new_task" | "approve" | "cancel" | "clarification_answer" | "chat"; task?: string };
  } catch {
    return { intent: "new_task", task: userMessage };
  }
}

export class DiscordBot {
  private client: Client;
  private env: Env;
  private sessions: Map<string, SessionState> = new Map();
  private chatSessions: Map<string, ClaudeSession> = new Map();
  private classifierSession: ClaudeSession;

  constructor(env: Env) {
    this.env = env;
    this.classifierSession = new ClaudeSession(env.CLAUDE_CLI);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel],
    });

    this.client.on("ready", () => {
      console.log(`Bot logged in as ${this.client.user?.tag}`);
      console.log(`Connected to ${this.client.guilds.cache.size} server(s):`);
      for (const guild of this.client.guilds.cache.values()) {
        console.log(`  - ${guild.name} (${guild.id})`);
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

    const session = this.getSession(message.channel.id);
    const isMention = message.mentions.has(this.client.user!);

    // Only respond if: mentioned, or there's an active session
    if (!isMention && session.phase === "idle") return;

    const content = message.content
      .replace(`<@${this.client.user!.id}>`, "")
      .replace(/<@&\d+>/g, "") // Remove role mentions
      .trim();

    console.log(`[MSG] ${message.author.tag}: "${content}" | session=${session.phase}`);

    const channel = message.channel as TextChannel;

    try {
      // Use Claude to understand what the user means
      console.log(`[CLASSIFY] Asking Claude to classify intent...`);
      const { intent, task } = await classifyIntent(
        this.classifierSession,
        content,
        session.phase
      );
      console.log(`[CLASSIFY] Intent: ${intent}`);

      switch (intent) {
        case "cancel":
          this.sessions.set(channel.id, { phase: "idle" });
          await channel.send("Session cancelled. Ready for a new task.");
          return;

        case "approve":
          if (session.phase === "awaiting_approval") {
            this.sessions.set(channel.id, {
              phase: "executing",
              pipeline: session.pipeline,
            });
            await channel.send("Plan approved! Starting workers...");
            await session.pipeline.executePlan(session.plan);
            return;
          }
          await channel.send("Nothing to approve right now. Send me a task to work on.");
          return;

        case "clarification_answer":
          if (session.phase === "clarifying") {
            await channel.send("Got it, updating the plan...");
            await session.pipeline.continueWithAnswers(content);
            return;
          }
          break;

        case "new_task": {
          const taskDescription = task || content;
          console.log(`[NEW] Starting task: ${taskDescription.slice(0, 100)}...`);
          await channel.send(`Got it! Analyzing your request...`);

          const pipeline = new Pipeline(this.env, (event) =>
            this.handlePipelineEvent(channel, event)
          );

          this.sessions.set(channel.id, { phase: "clarifying", pipeline });
          await pipeline.start(taskDescription);
          return;
        }

        case "chat":
        default: {
          // Persistent per-channel conversation — Claude remembers context
          let chatSession = this.chatSessions.get(channel.id);
          if (!chatSession) {
            chatSession = new ClaudeSession(this.env.CLAUDE_CLI);
            this.chatSessions.set(channel.id, chatSession);
          }

          const chatPrompt = chatSession.isActive
            ? content
            : `You are Daskyleion, a CTO bot managing an AI development swarm on Discord. Be concise, helpful, and conversational. You remember everything said in this channel.\n\nUser: ${content}`;

          const result = await chatSession.send(chatPrompt, { timeoutMs: 60_000 });
          const reply = result.text.slice(0, 1900) || "I'm here! Send me a task or @mention me to get started.";
          await channel.send(reply);
          return;
        }
      }
    } catch (error) {
      console.error(`[ERR]`, error);
      const errMsg = error instanceof Error ? error.message : String(error);
      // Don't leak internal prompts — show a clean error
      const cleanErr = errMsg.includes("timed out")
        ? "Request timed out — the task may be too complex. Try a simpler request."
        : errMsg.slice(0, 200);
      await channel.send(`Something went wrong: ${cleanErr}`);
      this.sessions.set(channel.id, { phase: "idle" });
    }
  }

  private async handlePipelineEvent(
    channel: TextChannel,
    event: PipelineEvent
  ): Promise<void> {
    const truncate = (s: string, max: number): string =>
      s.length <= max ? s : s.slice(0, max - 3) + "...";

    switch (event.type) {
      case "clarification": {
        const questions = event.questions
          .map((q, i) => `${i + 1}. ${q}`)
          .join("\n");
        await channel.send(
          `**Before I start, I need some clarification:**\n${questions}`
        );
        break;
      }

      case "plan": {
        const subtaskLines = event.plan.subtasks
          .map((s, i) => `**${i + 1}. ${s.title}**\n${s.description}`)
          .join("\n\n");

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
          .setFooter({ text: "Tell me to go ahead when you're ready, or give feedback." });

        await channel.send({ embeds: [embed] });

        // Send subtasks in chunks
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
        await channel.send(`**Iteration ${event.current}/${event.max}**`);
        break;

      case "workers_started":
        await channel.send(`Dispatching ${event.subtaskCount} worker(s) (max ${this.env.MAX_CONCURRENT_WORKERS} concurrent)...`);
        break;

      case "worker_completed":
        await channel.send(
          `Worker ${event.index}/${event.total} done: **${event.subtaskTitle}** — ${event.status}`
        );
        break;

      case "pipeline_timeout":
        await channel.send(
          `**Pipeline timeout reached.** ${event.completedWorkers}/${event.totalWorkers} workers finished before time ran out.`
        );
        this.sessions.set(channel.id, { phase: "idle" });
        break;

      case "workers_completed": {
        const completed = event.results.filter((r) => r.status === "completed").length;
        const blocked = event.results.filter((r) => r.status === "blocked").length;
        await channel.send(
          `Workers done: ${completed} completed, ${blocked} blocked. Sending to reviewer...`
        );
        break;
      }

      case "review_completed": {
        const { scores, feedback, verdict } = event.review;
        const embed = new EmbedBuilder()
          .setTitle(`Review — ${verdict}`)
          .setDescription(truncate(feedback, 4096))
          .addFields({
            name: "Scores",
            value: [
              `Correctness: ${scores.correctness}/10`,
              `Code Quality: ${scores.codeQuality}/10`,
              `Test Coverage: ${scores.testCoverage}/10`,
              `Security: ${scores.security}/10`,
              `Completeness: ${scores.completeness}/10`,
              `**Average: ${scores.average.toFixed(1)}/10**`,
            ].join("\n"),
          })
          .setColor(verdict === "APPROVE" ? 0x57f287 : 0xed4245);

        await channel.send({ embeds: [embed] });
        break;
      }

      case "approved":
        await channel.send(
          `**Task complete!** Approved after ${event.finalReview.iteration} iteration(s) with score ${event.finalReview.scores.average.toFixed(1)}/10.`
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
