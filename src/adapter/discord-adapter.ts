import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import { readFile } from "node:fs/promises";
import pLimit from "p-limit";
import { ClaudeSession } from "../agents/claude-session.js";
import { ChannelMutex } from "./channel-mutex.js";
import { ResourceGuard } from "./resource-guard.js";
import type { JobManager, Job } from "./job-manager.js";
import type { Env } from "../config/env.js";

/** Max concurrent Claude CLI invocations across all channels */
const MAX_CONCURRENT_SESSIONS = 5;

/**
 * Thin adapter that bridges Discord ↔ Claude CLI.
 *
 * No intent classification. No state machine. No custom routing.
 * Claude IS the bot — this just handles transport.
 */
export class DiscordAdapter {
  private client: Client;
  private env: Env;
  private sessions = new Map<string, ClaudeSession>();
  private mutex = new ChannelMutex();
  private resources: ResourceGuard;
  private jobManager: JobManager;
  private sessionLimiter = pLimit(MAX_CONCURRENT_SESSIONS);
  private mcpConfigPath: string | null = null;
  private systemPrompt: string | null = null;

  constructor(env: Env, jobManager: JobManager, resources: ResourceGuard) {
    this.env = env;
    this.jobManager = jobManager;
    this.resources = resources;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel],
    });

    this.client.on("ready", () => {
      console.log(`[adapter] Bot logged in as ${this.client.user?.tag}`);
      for (const guild of this.client.guilds.cache.values()) {
        console.log(`[adapter] Connected to ${guild.name} (${guild.id})`);
      }
    });

    this.client.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });
  }

  async start(): Promise<void> {
    // Load system prompt
    try {
      this.systemPrompt = await readFile(this.env.SYSTEM_PROMPT_PATH, "utf-8");
      console.log(`[adapter] System prompt loaded (${this.systemPrompt.length} chars)`);
    } catch (err) {
      console.warn(`[adapter] No system prompt at ${this.env.SYSTEM_PROMPT_PATH}, using default`);
      this.systemPrompt = null;
    }

    await this.client.login(this.env.DISCORD_BOT_TOKEN);
  }

  async stop(): Promise<void> {
    console.log("[adapter] Shutting down...");
    this.client.destroy();
  }

  setMcpConfigPath(path: string): void {
    this.mcpConfigPath = path;
  }

  private getOrCreateSession(channelId: string): ClaudeSession {
    let session = this.sessions.get(channelId);
    if (!session) {
      session = new ClaudeSession(
        this.env.CLAUDE_CLI,
        ["--dangerously-skip-permissions"],
        this.mcpConfigPath ?? undefined,
      );
      this.sessions.set(channelId, session);
    }
    return session;
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bots (including ourselves)
    if (message.author.bot) return;

    // Only respond to @mentions (for now — Phase 3 can add channel-watching)
    if (!message.mentions.has(this.client.user!)) return;

    // Message age filter — ignore messages older than MAX_MESSAGE_AGE_MS
    // This prevents the startup flood that caused the runaway agent incident
    const messageAge = Date.now() - message.createdTimestamp;
    if (messageAge > this.env.MAX_MESSAGE_AGE_MS) {
      console.log(
        `[adapter] Ignoring old message (${Math.round(messageAge / 1000)}s old) from ${message.author.tag}`
      );
      return;
    }

    // Strip the bot mention from the message content
    const content = message.content
      .replace(`<@${this.client.user!.id}>`, "")
      .replace(/<@&\d+>/g, "")
      .trim();

    if (!content) return;

    const channel = message.channel as TextChannel;

    console.log(
      `[adapter] ${message.author.tag} in #${channel.name}: "${content.slice(0, 100)}"`
    );

    // Resource check — refuse if system is overloaded
    const resourceSnap = this.resources.check();
    if (!resourceSnap.healthy) {
      console.warn(`[adapter] Resource limit hit: ${this.resources.statusLine()}`);
      await channel.send(
        `I'm currently at ${resourceSnap.memoryUsedPct}% memory usage (limit: ${this.env.MEMORY_CEILING_PCT}%). ` +
        `I need to wait for running tasks to finish before taking on new work.`
      );
      return;
    }

    // Serialize per channel — one message at a time
    const release = await this.mutex.acquire(channel.id);

    try {
      // Show typing indicator while Claude thinks
      await channel.sendTyping();

      const session = this.getOrCreateSession(channel.id);

      // Build the prompt
      // First message includes system prompt; subsequent messages just send the user's text
      // (Claude remembers the system prompt via --resume)
      const prompt = session.isActive
        ? `[${message.author.displayName}]: ${content}`
        : this.buildFirstPrompt(content, message.author.displayName);

      const result = await this.sessionLimiter(() =>
        session.send(prompt, {
          timeoutMs: this.env.CLAUDE_RESPONSE_TIMEOUT_MS,
        }),
      );

      console.log(
        `[adapter] Response (${result.durationMs}ms, $${result.costUsd.toFixed(4)}): ${result.text.slice(0, 100)}...`
      );

      // Send response, respecting Discord's 2000 char limit
      await this.sendChunked(channel, result.text);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[adapter] Error processing message:`, errMsg);

      if (errMsg.includes("timed out")) {
        await channel.send(
          "That took too long — the request may be too complex. Try breaking it down."
        );
      } else {
        await channel.send(
          `Something went wrong. Try again or rephrase your request.`
        );
      }

      // Reset session on error so next message starts fresh
      this.sessions.delete(channel.id);
    } finally {
      release();
    }
  }

  /**
   * Build the first prompt for a new session, including system prompt and resource context.
   */
  private buildFirstPrompt(userMessage: string, displayName: string): string {
    const parts: string[] = [];

    if (this.systemPrompt) {
      parts.push(this.systemPrompt);
    } else {
      parts.push(
        "You are Daskyleion, a CTO-level AI agent on Discord. Be concise, helpful, and conversational."
      );
    }

    // Inject resource status so Claude knows the system state
    parts.push("");
    parts.push(`## Current System Status`);
    parts.push(this.resources.statusLine());

    parts.push("");
    parts.push(`[${displayName}]: ${userMessage}`);

    return parts.join("\n");
  }

  /**
   * Send a message to Discord, splitting into chunks if it exceeds the 2000 char limit.
   */
  private async sendChunked(channel: TextChannel, text: string): Promise<void> {
    const maxLen = 1990; // Leave margin for safety

    if (text.length <= maxLen) {
      await channel.send(text || "_(empty response)_");
      return;
    }

    // Split on newlines first, then by length
    const lines = text.split("\n");
    let chunk = "";

    for (const line of lines) {
      if (chunk.length + line.length + 1 > maxLen) {
        if (chunk) await channel.send(chunk);
        chunk = line;
      } else {
        chunk += (chunk ? "\n" : "") + line;
      }
    }

    if (chunk) await channel.send(chunk);
  }

  /**
   * Called by JobManager when a job completes.
   * Builds a synthetic system message and sends it to the Claude session
   * for the relevant channel, then forwards Claude's response to Discord.
   */
  async handleJobCompletion(job: Job): Promise<void> {
    const channelId = job.channelId;
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) {
      console.warn(`[adapter] Job ${job.id} completed but channel ${channelId} not found`);
      return;
    }

    // Build synthetic notification
    let notification: string;
    if (job.type === "workers") {
      const total = job.workerResults?.length ?? 0;
      const completed = job.workerResults?.filter((r) => r.status === "completed").length ?? 0;
      const blocked = total - completed;
      const filesChanged = job.workerResults
        ?.flatMap((r) => r.files)
        .filter((f, i, arr) => arr.indexOf(f) === i) ?? [];
      notification =
        `[SYSTEM] Worker job ${job.id} ${job.status}. ` +
        `${completed}/${total} workers completed${blocked > 0 ? `, ${blocked} blocked` : ""}. ` +
        `Files changed: ${filesChanged.slice(0, 20).join(", ")}${filesChanged.length > 20 ? ` (+${filesChanged.length - 20} more)` : ""}. ` +
        `Use get_job_result("${job.id}") for details.`;
    } else if (job.type === "review") {
      const verdict = job.reviewResult?.verdict ?? "unknown";
      const avg = job.reviewResult?.scores.average.toFixed(1) ?? "?";
      notification =
        `[SYSTEM] Review job ${job.id} ${job.status}. ` +
        `Verdict: ${verdict}, average score: ${avg}. ` +
        `Use get_job_result("${job.id}") for details.`;
      if (job.featureBranch) {
        notification += ` Changes merged to branch: ${job.featureBranch}`;
      }
    } else {
      notification = `[SYSTEM] Job ${job.id} ${job.status}.`;
    }

    if (job.status === "failed") {
      notification += ` Error: ${job.error ?? "unknown"}`;
    }

    console.log(`[adapter] Sending job notification to #${channel.name}: ${notification.slice(0, 120)}...`);

    const release = await this.mutex.acquire(channelId);
    try {
      await channel.sendTyping();
      const session = this.getOrCreateSession(channelId);
      const result = await this.sessionLimiter(() =>
        session.send(notification, {
          timeoutMs: this.env.CLAUDE_RESPONSE_TIMEOUT_MS,
        }),
      );

      console.log(
        `[adapter] Job notification response (${result.durationMs}ms): ${result.text.slice(0, 100)}...`
      );

      await this.sendChunked(channel, result.text);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[adapter] Error sending job notification:`, errMsg);
      await channel.send(
        `A job finished but I had trouble processing the results. Job ID: ${job.id}`
      ).catch(() => {});
    } finally {
      release();
    }
  }
}
