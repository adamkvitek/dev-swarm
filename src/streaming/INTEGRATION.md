# Streaming Discord Integration

This document describes how to wire `src/streaming/` into the existing Discord adapter.
These changes require modifying control plane files (`src/adapter/discord-adapter.ts`)
and must be done by a human.

## Overview

The streaming module replaces the buffered `ClaudeSession` with `StreamingClaudeSession`.
Instead of waiting for the full response and then dumping it to Discord, Claude's response
streams live — the Discord message updates every ~1.5 seconds as tokens arrive.

## Changes to `src/adapter/discord-adapter.ts`

### 1. Replace imports

```diff
-import { ClaudeSession } from "../agents/claude-session.js";
+import { SessionManager, StreamingClaudeSession, DiscordStreamHandler } from "../streaming/index.js";
```

### 2. Replace session management

Replace the `sessions` map and `getOrCreateSession` with the `SessionManager`:

```diff
 export class DiscordAdapter {
   private client: Client;
   private env: Env;
-  private sessions = new Map<string, ClaudeSession>();
+  private sessionManager: SessionManager;
   private mutex = new ChannelMutex();
   ...

   constructor(env: Env, jobManager: JobManager, resources: ResourceGuard) {
     ...
+    this.sessionManager = new SessionManager({
+      claudeCli: env.CLAUDE_CLI,
+      extraArgs: ["--dangerously-skip-permissions"],
+    });
     ...
   }
```

### 3. Update `setMcpConfigPath`

```diff
   setMcpConfigPath(path: string): void {
     this.mcpConfigPath = path;
+    this.sessionManager.updateMcpConfigPath(path);
   }
```

### 4. Update `buildSystemPrompt` call

After building the system prompt in `start()`, pass it to the session manager:

```diff
   async start(): Promise<void> {
     try {
       this.systemPrompt = await readFile(this.env.SYSTEM_PROMPT_PATH, "utf-8");
     } catch { ... }

+    this.sessionManager.updateSystemPrompt(this.buildSystemPrompt());
     await this.client.login(this.env.DISCORD_BOT_TOKEN);
   }
```

### 5. Replace `handleMessage` with streaming version

Replace the core message handler:

```typescript
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
  log.adapter.info(
    { author: message.author.tag, channel: channel.name, preview: content.slice(0, 100) },
    "Incoming message",
  );

  const resourceSnap = this.resources.check();
  if (!resourceSnap.healthy) {
    await channel.send(
      `I'm currently at ${resourceSnap.memoryUsedPct}% memory usage. ` +
      `I need to wait for running tasks to finish.`
    );
    return;
  }

  const release = await this.mutex.acquire(channel.id);
  const streamHandler = new DiscordStreamHandler(channel);

  try {
    await channel.sendTyping();

    // First-run announcement
    if (!this.firstRunAnnounced.has(channel.id)) {
      this.firstRunAnnounced.add(channel.id);
      const hw = detectedHardware;
      await this.sendWithRateLimit(channel,
        `**System initialized** — detected ${hw.cores} CPU cores, ${hw.ramGb}GB RAM. ` +
        `Using ${this.env.MAX_CONCURRENT_WORKERS} parallel workers, ` +
        `${this.env.MEMORY_CEILING_PCT}% memory ceiling.`
      );
    }

    const session = this.sessionManager.getOrCreate(channel.id);
    const prompt = `[${message.author.displayName}]: ${content}`;

    const result = await this.sessionLimiter(() =>
      session.send(prompt, {
        onTextDelta: (text) => streamHandler.appendText(text),
        onToolUseStart: (name) => streamHandler.showToolUse(name),
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
    release();
  }
}
```

### 6. Update `handleJobCompletion` similarly

Replace `session.send(...)` with streaming in `handleJobCompletion`:

```typescript
async handleJobCompletion(job: Job): Promise<void> {
  const channel = this.client.channels.cache.get(job.channelId) as TextChannel | undefined;
  if (!channel) return;

  // Build notification...
  const notification = /* same as before */;

  const release = await this.mutex.acquire(job.channelId);
  const streamHandler = new DiscordStreamHandler(channel);

  try {
    await channel.sendTyping();
    const session = this.sessionManager.getOrCreate(job.channelId);
    const result = await this.sessionLimiter(() =>
      session.send(notification, {
        onTextDelta: (text) => streamHandler.appendText(text),
        onToolUseStart: (name) => streamHandler.showToolUse(name),
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
    await streamHandler.finalize();
    await channel.send(
      `A job finished but I had trouble processing the results. Job ID: ${job.id}`
    ).catch(() => {});
  } finally {
    release();
  }
}
```

### 7. Update `stop()` for cleanup

```diff
   async stop(): Promise<void> {
     log.adapter.info("Shutting down...");
+    this.sessionManager.clear();
     this.client.destroy();
   }
```

### 8. Remove old `getOrCreateSession` and `tryRecoverSession`

These are replaced by `SessionManager.getOrCreate()` and the simpler
error-handling pattern (reset on error instead of retry).

## What this enables

- Messages update live as Claude generates tokens (~1.5s intervals)
- Tool use is visible: "> *Using tool: spawn_workers...*"
- Conversation persists across messages via `--resume`
- Long responses automatically split into multiple Discord messages
- Multiple channels stream simultaneously (one session per channel)
- Existing MCP worker/review spawning continues to work
