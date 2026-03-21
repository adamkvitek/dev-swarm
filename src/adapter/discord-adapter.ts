import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import { readFile } from "node:fs/promises";
import pLimit from "p-limit";
import { SessionManager, DiscordStreamHandler } from "../streaming/index.js";
import { ChannelMutex } from "./channel-mutex.js";
import { ResourceGuard } from "./resource-guard.js";
import { log } from "../logger.js";
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
  private sessionManager: SessionManager;
  private mutex = new ChannelMutex();
  private resources: ResourceGuard;
  private jobManager: JobManager;
  private sessionLimiter = pLimit(MAX_CONCURRENT_SESSIONS);
  private mcpConfigPath: string | null = null;
  private systemPrompt: string | null = null;
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Channels where users have sent messages this session — resource warnings go here only */
  private activeChannels = new Map<string, { channel: TextChannel; lastActivity: number }>();

  constructor(env: Env, jobManager: JobManager, resources: ResourceGuard) {
    this.env = env;
    this.jobManager = jobManager;
    this.resources = resources;
    this.sessionManager = new SessionManager({
      claudeCli: env.CLAUDE_CLI,
      extraArgs: ["--dangerously-skip-permissions"],
    });

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel],
    });

    this.client.on("ready", () => {
      log.adapter.info({ tag: this.client.user?.tag }, "Bot logged in");
      for (const guild of this.client.guilds.cache.values()) {
        log.adapter.info({ guild: guild.name, guildId: guild.id }, "Connected to guild");
      }
      // No startup banner — resource warnings are sent only to channels
      // where users have active sessions, not guild-wide.

      // Start proactive resource monitoring (polls every 30s)
      this.resources.startMonitoring((transition) => {
        this.handleProactiveResourceChange(transition);
      });
    });

    this.client.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });
  }

  async start(): Promise<void> {
    // Load system prompt
    try {
      this.systemPrompt = await readFile(this.env.SYSTEM_PROMPT_PATH, "utf-8");
      log.adapter.info({ chars: this.systemPrompt.length }, "System prompt loaded");
    } catch (err) {
      log.adapter.warn({ path: this.env.SYSTEM_PROMPT_PATH }, "No system prompt found, using default");
      this.systemPrompt = null;
    }

    this.sessionManager.updateSystemPrompt(this.buildSystemPrompt());
    await this.client.login(this.env.DISCORD_BOT_TOKEN);
  }

  async stop(): Promise<void> {
    log.adapter.info("Shutting down...");
    this.resources.stopMonitoring();
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    this.sessionManager.clear();
    this.client.destroy();
  }

  setMcpConfigPath(path: string): void {
    this.mcpConfigPath = path;
    this.sessionManager.updateMcpConfigPath(path);
  }

  /**
   * Compact a channel's Claude session by sending a /compact command.
   * This asks Claude to summarize the conversation context, reducing token usage.
   */
  private async compactSession(channel: TextChannel): Promise<void> {
    if (!this.sessionManager.hasSession(channel.id)) {
      await channel.send("No active session to compact.");
      return;
    }

    const release = await this.mutex.acquire(channel.id);
    const streamHandler = new DiscordStreamHandler(channel);

    try {
      this.startTyping(channel);
      streamHandler.onFirstFlush = () => this.stopTyping(channel.id);

      const session = this.sessionManager.getOrCreate(channel.id);
      const result = await this.sessionLimiter(() =>
        session.send(
          "[SYSTEM: The user wants to compact this conversation. Summarize the key context and decisions so far in a brief, structured format. Then confirm the session has been compacted.]",
          {
            onTextDelta: (text) => streamHandler.appendText(text),
            onToolUseStart: (name) => {
              this.startTyping(channel);
              streamHandler.showToolUse(name);
            },
            onToolUseEnd: () => streamHandler.clearToolUse(),
          },
          { timeoutMs: this.env.CLAUDE_RESPONSE_TIMEOUT_MS },
        ),
      );

      await streamHandler.finalize();
      if (!streamHandler.hasContent && result.text) {
        await this.sendChunked(channel, result.text);
      }
    } catch (error) {
      this.stopTyping(channel.id);
      await streamHandler.finalize();
      await channel.send("Failed to compact session. Try /clear to start fresh.").catch(() => {});
    } finally {
      this.stopTyping(channel.id);
      release();
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.mentions.has(this.client.user!)) return;

    const messageAge = Date.now() - message.createdTimestamp;
    if (messageAge > this.env.MAX_MESSAGE_AGE_MS) {
      log.adapter.info({ ageSeconds: Math.round(messageAge / 1000) }, "Ignoring old message");
      return;
    }

    const content = message.content
      .replace(`<@${this.client.user!.id}>`, "")
      .replace(/<@&\d+>/g, "")
      .trim();
    if (!content) return;

    const channel = message.channel as TextChannel;
    this.activeChannels.set(channel.id, { channel, lastActivity: Date.now() });

    // Handle session management commands before sending to Claude
    const command = content.toLowerCase();
    if (command === "/clear" || command === "clear") {
      this.sessionManager.reset(channel.id);
      await channel.send("Session cleared. Next message starts a fresh conversation.");
      return;
    }
    if (command === "/compact" || command === "compact") {
      await this.compactSession(channel);
      return;
    }

    log.adapter.info(
      { author: message.author.tag, channel: channel.name, preview: content.slice(0, 100) },
      "Incoming message",
    );

    const release = await this.mutex.acquire(channel.id);
    const streamHandler = new DiscordStreamHandler(channel);

    try {
      // Keep typing indicator alive until first message is visible in Discord
      this.startTyping(channel);
      streamHandler.onFirstFlush = () => this.stopTyping(channel.id);

      const session = this.sessionManager.getOrCreate(channel.id);

      // Always process the message — inject resource constraint note if needed
      const resourceSnap = this.resources.check();
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      let prompt = `[${message.author.displayName} at ${timestamp}]: ${content}`;
      if (!resourceSnap.healthy || !resourceSnap.canSpawnMore) {
        const issues: string[] = [];
        if (!resourceSnap.memoryHealthy) issues.push(`memory at ${resourceSnap.memoryUsedPct}%`);
        if (!resourceSnap.cpuHealthy) issues.push(`CPU at ${resourceSnap.cpuUsedPct}%`);
        if (resourceSnap.activeWorkers >= resourceSnap.maxWorkers) issues.push("all worker slots in use");
        prompt += `\n\n[SYSTEM: Resources are constrained — ${issues.join(", ")}. ` +
          `Do not spawn new workers. Respond to the user's message normally but if they ask for worker tasks, ` +
          `explain that worker spawning is paused until resources free up.]`;
      }

      const result = await this.sessionLimiter(() =>
        session.send(prompt, {
          onTextDelta: (text) => {
            streamHandler.appendText(text);
          },
          onToolUseStart: (name) => {
            // Re-enable typing during tool execution so users see activity
            this.startTyping(channel);
            streamHandler.showToolUse(name);
          },
          onToolUseEnd: () => streamHandler.clearToolUse(),
        }, {
          timeoutMs: this.env.CLAUDE_RESPONSE_TIMEOUT_MS,
        }),
      );

      await streamHandler.finalize();

      log.adapter.info(
        { durationMs: result.durationMs, costUsd: result.costUsd, preview: result.text.slice(0, 100) },
        "Streaming response completed",
      );

      // If streaming produced no visible content, send the final text as fallback
      if (!streamHandler.hasContent && result.text) {
        await this.sendChunked(channel, result.text);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.adapter.error({ err: errMsg }, "Error in streaming message");

      this.stopTyping(channel.id);
      await streamHandler.finalize();

      if (errMsg.includes("timed out")) {
        await streamHandler.showError(
          "That took too long — try breaking it down into smaller requests."
        );
      } else {
        await streamHandler.showError(
          "Something went wrong. Try again or rephrase your request."
        );
        this.sessionManager.reset(channel.id);
      }
    } finally {
      this.stopTyping(channel.id);
      release();

      // Check resource state transitions and notify active channels
      this.checkResourceTransitions();
    }
  }

  /**
   * Get channels with recent activity (within last 4 hours) and evict stale entries.
   */
  private getRecentChannels(): TextChannel[] {
    const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours
    const now = Date.now();
    const channels: TextChannel[] = [];
    for (const [id, entry] of this.activeChannels) {
      if (now - entry.lastActivity > STALE_MS) {
        this.activeChannels.delete(id);
      } else {
        channels.push(entry.channel);
      }
    }
    return channels;
  }

  /**
   * Check for resource state changes and notify active channels.
   * Only channels where users have sent messages this session get notified.
   */
  private checkResourceTransitions(): void {
    const { warning, recovery } = this.resources.checkTransition();
    const message = warning ?? recovery;
    if (!message) return;

    const channels = this.getRecentChannels();
    log.adapter.info(
      { warning: !!warning, recovery: !!recovery, activeChannels: channels.length },
      "Resource state changed, notifying active channels",
    );

    for (const ch of channels) {
      ch.send(message).catch((err) => {
        log.adapter.warn(
          { err: err instanceof Error ? err.message : String(err), channelId: ch.id },
          "Failed to send resource notification",
        );
      });
    }
  }

  /**
   * Handle proactive resource state changes detected by the periodic monitor.
   * On recovery: notifies active channels AND injects a [SYSTEM] prompt into
   * active Claude sessions telling the CTO to resume interrupted work.
   */
  private handleProactiveResourceChange(transition: { warning: string | null; recovery: string | null }): void {
    const message = transition.warning ?? transition.recovery;
    const channels = this.getRecentChannels();
    if (!message || channels.length === 0) return;

    log.adapter.info(
      { warning: !!transition.warning, recovery: !!transition.recovery, activeChannels: channels.length },
      "Proactive resource monitor triggered",
    );

    for (const ch of channels) {
      // Send user-facing notification
      ch.send(message).catch((err) => {
        log.adapter.warn(
          { err: err instanceof Error ? err.message : String(err), channelId: ch.id },
          "Failed to send proactive resource notification",
        );
      });

      // On recovery: drain the job queue and inject a system prompt into
      // the Claude session so the CTO knows it can resume interrupted work
      if (transition.recovery) {
        const started = this.jobManager.drainQueue();
        if (started > 0) {
          log.adapter.info({ started }, "Recovery: drained queued jobs");
        }
      }

      if (transition.recovery && this.sessionManager.hasSession(ch.id)) {
        // Acquire per-channel mutex to prevent racing with user messages
        void this.mutex.acquire(ch.id).then(async (release) => {
          const session = this.sessionManager.getOrCreate(ch.id);
          const streamHandler = new DiscordStreamHandler(ch);
          this.startTyping(ch);
          streamHandler.onFirstFlush = () => this.stopTyping(ch.id);

          const resumePrompt =
            "[SYSTEM: Resources have recovered — full capabilities restored. " +
            "If you were working on a task that was interrupted by resource constraints, " +
            "resume where you left off. Check resources with check_resources to confirm, " +
            "then continue. Do not start new work that wasn't already requested.]";

          try {
            const result = await this.sessionLimiter(() =>
              session.send(resumePrompt, {
                onTextDelta: (text) => streamHandler.appendText(text),
                onToolUseStart: (name) => {
                  this.startTyping(ch);
                  streamHandler.showToolUse(name);
                },
                onToolUseEnd: () => streamHandler.clearToolUse(),
              }, {
                timeoutMs: this.env.CLAUDE_RESPONSE_TIMEOUT_MS,
              }),
            );
            await streamHandler.finalize();
            if (!streamHandler.hasContent && result.text) {
              await this.sendChunked(ch, result.text);
            }
          } catch (err) {
            this.stopTyping(ch.id);
            await streamHandler.finalize();
            log.adapter.error(
              { err: err instanceof Error ? err.message : String(err), channelId: ch.id },
              "Failed to send resume prompt after recovery",
            );
          } finally {
            this.stopTyping(ch.id);
            release();
          }
        });
      }
    }
  }

  /**
   * Keep Discord's "typing..." indicator alive by re-sending it every 8s.
   * Discord's typing indicator expires after ~10s, so 8s keeps it seamless.
   */
  private startTyping(channel: TextChannel): void {
    this.stopTyping(channel.id);
    channel.sendTyping().catch(() => {});
    const timer = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 8_000);
    this.typingTimers.set(channel.id, timer);
  }

  private stopTyping(channelId: string): void {
    const timer = this.typingTimers.get(channelId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(channelId);
    }
  }

  /**
   * Build the system prompt (passed via --append-system-prompt, NOT mixed with user message).
   */
  private buildSystemPrompt(): string {
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

    return parts.join("\n");
  }

  /**
   * Send a message to Discord, splitting into chunks if it exceeds the 2000 char limit.
   * Handles Discord 429 rate limits with automatic retry + backoff.
   */
  private async sendChunked(channel: TextChannel, text: string): Promise<void> {
    const maxLen = 1990; // Leave margin for safety

    if (text.length <= maxLen) {
      await this.sendWithRateLimit(channel, text || "_(empty response)_");
      return;
    }

    // Split on newlines first, then by length.
    // If a single line exceeds maxLen, hard-split it at maxLen boundaries.
    const lines = text.split("\n");
    let chunk = "";

    for (const line of lines) {
      // Hard-split lines that exceed maxLen on their own
      const segments: string[] = [];
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) {
          segments.push(line.slice(i, i + maxLen));
        }
      } else {
        segments.push(line);
      }

      for (const segment of segments) {
        if (chunk.length + segment.length + 1 > maxLen) {
          if (chunk) await this.sendWithRateLimit(channel, chunk);
          chunk = segment;
        } else {
          chunk += (chunk ? "\n" : "") + segment;
        }
      }
    }

    if (chunk) await this.sendWithRateLimit(channel, chunk);
  }

  /**
   * Send a single message with automatic retry on Discord 429 rate limits.
   */
  private async sendWithRateLimit(channel: TextChannel, text: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await channel.send(text);
        return;
      } catch (err) {
        const isRateLimit = err instanceof Error && err.message.includes("rate limit");
        if (!isRateLimit || attempt === 2) throw err;

        const delay = (attempt + 1) * 2000; // 2s, 4s
        log.adapter.warn({ delayMs: delay, attempt: attempt + 1 }, "Discord rate limited, retrying");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Called by JobManager when a job completes.
   * Builds a synthetic system message and sends it to the Claude session
   * for the relevant channel, then streams Claude's response to Discord.
   */
  async handleJobCompletion(job: Job): Promise<void> {
    const channelId = job.channelId;
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) {
      log.adapter.warn({ jobId: job.id, channelId }, "Job completed but channel not found");
      return;
    }

    // Build synthetic notification
    let notification: string = `[SYSTEM] Job ${job.id} ${job.status}.`;
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
    }

    if (job.status === "failed") {
      notification += ` Error: ${job.error ?? "unknown"}`;
    }

    log.adapter.info({ jobId: job.id, channel: channel.name, preview: notification.slice(0, 120) }, "Sending job notification");

    const release = await this.mutex.acquire(channelId);
    const streamHandler = new DiscordStreamHandler(channel);

    try {
      this.startTyping(channel);
      streamHandler.onFirstFlush = () => this.stopTyping(channelId);
      const session = this.sessionManager.getOrCreate(channelId);
      const result = await this.sessionLimiter(() =>
        session.send(notification, {
          onTextDelta: (text) => {
            streamHandler.appendText(text);
          },
          onToolUseStart: (name) => {
            this.startTyping(channel);
            streamHandler.showToolUse(name);
          },
          onToolUseEnd: () => streamHandler.clearToolUse(),
        }, {
          timeoutMs: this.env.CLAUDE_RESPONSE_TIMEOUT_MS,
        }),
      );
      await streamHandler.finalize();

      if (!streamHandler.hasContent && result.text) {
        await this.sendChunked(channel, result.text);
      }
    } catch (error) {
      this.stopTyping(channelId);
      await streamHandler.finalize();
      await channel.send(
        `A job finished but I had trouble processing the results. Job ID: ${job.id}`
      ).catch(() => {});
    } finally {
      this.stopTyping(channelId);
      release();
    }
  }
}
