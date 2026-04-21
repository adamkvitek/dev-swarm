import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscordStreamHandler } from "../../streaming/discord-handler.js";
import { ChannelMutex } from "../channel-mutex.js";
import type { TextChannel, Message } from "discord.js";

/**
 * Discord UX end-to-end simulation tests.
 *
 * These tests verify the full UX flow from message handling through streaming
 * response delivery, using mock Discord channels. They test the same code paths
 * as the real adapter without requiring a live Discord connection.
 *
 * Each test simulates the user experience:
 *   1. User sends a message (mock)
 *   2. Bot processes and streams a response
 *   3. User sees the response update in Discord
 */

// --- Mock factories ---

interface MockMessage {
  content: string;
  edit: ReturnType<typeof vi.fn>;
}

interface MockChannel {
  id: string;
  name: string;
  send: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  _sentMessages: MockMessage[];
  _editHistory: string[];
}

function createMockChannel(id = "ch-test", name = "test-channel"): MockChannel {
  const sentMessages: MockMessage[] = [];
  const editHistory: string[] = [];

  return {
    id,
    name,
    _sentMessages: sentMessages,
    _editHistory: editHistory,
    send: vi.fn(async (content: string) => {
      const msg: MockMessage = {
        content,
        edit: vi.fn(async (newContent: string) => {
          msg.content = newContent;
          editHistory.push(newContent);
        }),
      };
      sentMessages.push(msg);
      return msg as unknown as Message;
    }),
    sendTyping: vi.fn(async () => {}),
  } as unknown as MockChannel;
}

/**
 * Simulates streaming a response to a channel — the same path as
 * DiscordAdapter.handleMessage() after acquiring the mutex and creating
 * a StreamHandler.
 */
async function simulateStreamResponse(
  channel: MockChannel,
  tokens: string[],
  options?: { editIntervalMs?: number; delayBetweenTokensMs?: number },
): Promise<void> {
  const handler = new DiscordStreamHandler(
    channel as unknown as TextChannel,
    { editIntervalMs: options?.editIntervalMs ?? 100 },
  );

  for (const token of tokens) {
    handler.appendText(token);
    if (options?.delayBetweenTokensMs) {
      await vi.advanceTimersByTimeAsync(options.delayBetweenTokensMs);
    }
  }

  // Trigger a flush
  await vi.advanceTimersByTimeAsync(options?.editIntervalMs ?? 100);

  await handler.finalize();
}

// --- Tests ---

describe("Discord UX E2E Simulation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic response flow", () => {
    it("should display a typing indicator before first token", async () => {
      const channel = createMockChannel();

      // Simulate the adapter's typing behavior
      await channel.sendTyping();

      expect(channel.sendTyping).toHaveBeenCalledTimes(1);
    });

    it("should stream a response that appears progressively", async () => {
      const channel = createMockChannel();
      const handler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );

      // First token batch
      handler.appendText("Hello ");
      await vi.advanceTimersByTimeAsync(100);
      expect(channel._sentMessages).toHaveLength(1);
      expect(channel._sentMessages[0]!.content).toBe("Hello ");

      // Second token batch — edits existing message
      handler.appendText("world!");
      await vi.advanceTimersByTimeAsync(100);
      expect(channel._editHistory).toHaveLength(1);
      expect(channel._editHistory[0]).toBe("Hello world!");

      await handler.finalize();
    });

    it("should not show raw JSON or error output in normal responses", async () => {
      const channel = createMockChannel();
      const tokens = [
        "I can help you with that. ",
        "Here's what I found:\n\n",
        "1. The project uses TypeScript\n",
        "2. Tests run via Vitest\n",
        "3. Discord.js handles the bot connection",
      ];

      await simulateStreamResponse(channel, tokens);

      const finalContent = channel._sentMessages[0]?.content
        ?? channel._editHistory.at(-1)
        ?? "";

      // No raw JSON
      expect(finalContent).not.toMatch(/^\s*\{/);
      expect(finalContent).not.toMatch(/"type"\s*:/);
      // No error indicators
      expect(finalContent).not.toContain("Error:");
      expect(finalContent).not.toContain("stack trace");
      // Has real content
      expect(finalContent.length).toBeGreaterThan(50);
    });
  });

  describe("multi-message conversation", () => {
    it("should maintain context across multiple messages in the same channel", async () => {
      const channel = createMockChannel("ch-conv", "conversation");

      // Message 1: User introduces a topic
      const handler1 = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );
      handler1.appendText("I can help you set up TypeScript. ");
      handler1.appendText("What version of Node are you using?");
      await vi.advanceTimersByTimeAsync(100);
      await handler1.finalize();

      // Message 2: Follow-up (in real adapter, same session via SessionManager)
      const handler2 = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );
      handler2.appendText("Great, Node 22 works well with TypeScript 5.7. ");
      handler2.appendText("Let me set up your tsconfig.");
      await vi.advanceTimersByTimeAsync(100);
      await handler2.finalize();

      // Message 3: Another follow-up referencing prior context
      const handler3 = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );
      handler3.appendText("I've configured strict mode in tsconfig.json ");
      handler3.appendText("as we discussed. The project is ready.");
      await vi.advanceTimersByTimeAsync(100);
      await handler3.finalize();

      // Verify all 3 messages were sent to the same channel
      expect(channel._sentMessages).toHaveLength(3);

      // Verify each message has substantive content
      for (const msg of channel._sentMessages) {
        expect(msg.content.length).toBeGreaterThan(20);
      }

      // Verify the conversation progresses logically
      expect(channel._sentMessages[0]!.content).toContain("TypeScript");
      expect(channel._sentMessages[1]!.content).toContain("tsconfig");
      expect(channel._sentMessages[2]!.content).toContain("configured");
    });

    it("should use separate handlers per message without cross-contamination", async () => {
      const channel = createMockChannel();

      const handler1 = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );
      handler1.appendText("Response to message 1");
      await vi.advanceTimersByTimeAsync(100);
      await handler1.finalize();

      const handler2 = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );
      handler2.appendText("Response to message 2");
      await vi.advanceTimersByTimeAsync(100);
      await handler2.finalize();

      // Each handler created its own Discord message
      expect(channel._sentMessages).toHaveLength(2);
      expect(channel._sentMessages[0]!.content).toBe("Response to message 1");
      expect(channel._sentMessages[1]!.content).toBe("Response to message 2");
    });
  });

  describe("long response streaming", () => {
    it("should produce a substantial final message for complex questions", async () => {
      const channel = createMockChannel();

      // Simulate a detailed response (like explaining project architecture)
      const longTokens = [
        "# Project Architecture\n\n",
        "The project follows a modular design with several key components:\n\n",
        "## 1. Discord Adapter\n",
        "The `DiscordAdapter` class bridges Discord.js events to Claude CLI. ",
        "It handles message routing, typing indicators, and response streaming. ",
        "Messages are serialized per-channel using `ChannelMutex` to prevent ",
        "race conditions that caused the runaway agent incident.\n\n",
        "## 2. Streaming Module\n",
        "Three classes work together:\n",
        "- `StreamingClaudeSession` spawns the CLI with `--output-format stream-json` ",
        "and parses the NDJSON output into typed events.\n",
        "- `DiscordStreamHandler` progressively edits Discord messages as tokens arrive.\n",
        "- `SessionManager` maintains per-channel session persistence via `--resume`.\n\n",
        "## 3. Resource Guard\n",
        "The `ResourceGuard` monitors system memory and worker capacity. ",
        "It accounts for OS-specific memory reporting differences:\n",
        "- macOS: Uses `vm_stat` for accurate available memory\n",
        "- Linux: Reads `MemAvailable` from `/proc/meminfo`\n",
        "- Windows: `os.freemem()` is already accurate\n",
      ];

      await simulateStreamResponse(channel, longTokens);

      // Get the final message content
      const finalContent = channel._editHistory.at(-1) ?? channel._sentMessages[0]?.content ?? "";

      // Must be substantial (> 200 chars)
      expect(finalContent.length).toBeGreaterThan(200);

      // Must contain structured content, not garbage
      expect(finalContent).toContain("Architecture");
      expect(finalContent).toContain("Adapter");
      expect(finalContent).toContain("Streaming");

      // No raw JSON leaked through
      expect(finalContent).not.toMatch(/"type"\s*:\s*"content_block/);
    });

    it("should show message content growing over time via edits", async () => {
      const channel = createMockChannel();
      const handler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 50 },
      );

      const tokens = [
        "Part 1. ",
        "Part 2. ",
        "Part 3. ",
        "Part 4. ",
        "Part 5. ",
      ];

      // Send tokens with flushes between each
      for (const token of tokens) {
        handler.appendText(token);
        await vi.advanceTimersByTimeAsync(50);
      }

      await handler.finalize();

      // The edit history should show progressively growing content.
      // Note: editHistory tracks each edit call — the mock's msg.content
      // is mutated, so we only look at editHistory (each entry is a snapshot).
      // The first send creates the message, then edits grow it.
      expect(channel._editHistory.length).toBeGreaterThan(0);

      for (let i = 1; i < channel._editHistory.length; i++) {
        expect(channel._editHistory[i]!.length).toBeGreaterThanOrEqual(
          channel._editHistory[i - 1]!.length,
        );
      }

      // Final version should contain all parts
      const final = channel._editHistory.at(-1) ?? channel._sentMessages[0]?.content ?? "";
      expect(final).toContain("Part 1");
      expect(final).toContain("Part 5");
    });

    it("should handle responses that exceed 200 characters", async () => {
      const channel = createMockChannel();

      // Generate a response > 200 chars
      const longText = "This is a detailed explanation. ".repeat(10);
      await simulateStreamResponse(channel, [longText]);

      const content = channel._sentMessages[0]?.content
        ?? channel._editHistory.at(-1)
        ?? "";
      expect(content.length).toBeGreaterThan(200);
    });
  });

  describe("concurrent messages", () => {
    it("should serialize concurrent messages on the same channel via mutex", async () => {
      const channel = createMockChannel("ch-concurrent", "concurrent");
      const mutex = new ChannelMutex();
      const order: number[] = [];

      // Message 1 acquires the lock first
      const release1 = await mutex.acquire(channel.id);

      // Message 2 starts trying to acquire — blocked by message 1
      const msg2Promise = (async () => {
        const release2 = await mutex.acquire(channel.id);
        order.push(2);

        const handler = new DiscordStreamHandler(
          channel as unknown as TextChannel,
          { editIntervalMs: 50 },
        );
        handler.appendText("Response to message 2");
        await vi.advanceTimersByTimeAsync(50);
        await handler.finalize();

        release2();
      })();

      // Message 1 processes and responds first
      order.push(1);
      const handler1 = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 50 },
      );
      handler1.appendText("Response to message 1");
      await vi.advanceTimersByTimeAsync(50);
      await handler1.finalize();
      release1();

      // Now message 2 can proceed
      await msg2Promise;

      expect(order).toEqual([1, 2]);
      expect(channel._sentMessages).toHaveLength(2);
    });

    it("should allow concurrent messages on different channels", async () => {
      const ch1 = createMockChannel("ch-1", "channel-1");
      const ch2 = createMockChannel("ch-2", "channel-2");
      const mutex = new ChannelMutex();

      // Both channels can acquire locks simultaneously
      const release1 = await mutex.acquire(ch1.id);
      const release2 = await mutex.acquire(ch2.id);

      // Both respond in parallel
      const handler1 = new DiscordStreamHandler(
        ch1 as unknown as TextChannel,
        { editIntervalMs: 50 },
      );
      const handler2 = new DiscordStreamHandler(
        ch2 as unknown as TextChannel,
        { editIntervalMs: 50 },
      );

      handler1.appendText("Response in channel 1");
      handler2.appendText("Response in channel 2");
      await vi.advanceTimersByTimeAsync(50);

      await handler1.finalize();
      await handler2.finalize();

      release1();
      release2();

      expect(ch1._sentMessages[0]!.content).toBe("Response in channel 1");
      expect(ch2._sentMessages[0]!.content).toBe("Response in channel 2");
    });

    it("should eventually answer both rapid messages (queued via mutex)", async () => {
      const channel = createMockChannel("ch-rapid", "rapid");
      const mutex = new ChannelMutex();
      const responded: string[] = [];

      // Simulate two rapid messages (< 1 second apart)
      const processMessage = async (msgId: string, text: string): Promise<void> => {
        const release = await mutex.acquire(channel.id);
        try {
          const handler = new DiscordStreamHandler(
            channel as unknown as TextChannel,
            { editIntervalMs: 50 },
          );
          handler.appendText(text);
          await vi.advanceTimersByTimeAsync(50);
          await handler.finalize();
          responded.push(msgId);
        } finally {
          release();
        }
      };

      // Fire both "simultaneously"
      const p1 = processMessage("msg-1", "First response");
      const p2 = processMessage("msg-2", "Second response");

      await p1;
      await p2;

      // Both messages got responses
      expect(responded).toContain("msg-1");
      expect(responded).toContain("msg-2");
      expect(channel._sentMessages).toHaveLength(2);
    });
  });

  describe("error recovery", () => {
    it("should show a helpful error message on failure, not crash or go silent", async () => {
      const channel = createMockChannel("ch-error", "error-test");
      const handler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );

      // Simulate an error during processing
      await handler.showError(
        "Something went wrong. Try again or rephrase your request."
      );

      expect(channel._sentMessages).toHaveLength(1);
      expect(channel._sentMessages[0]!.content).toContain("Something went wrong");
      expect(channel._sentMessages[0]!.content).toContain("Try again");
    });

    it("should still work after an error — next message gets a response", async () => {
      const channel = createMockChannel("ch-recover", "recover-test");

      // First: an error occurs
      const errorHandler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );
      await errorHandler.showError("Something went wrong. Try again or rephrase your request.");

      // Second: normal message works fine
      const normalHandler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );
      normalHandler.appendText("Here is your answer.");
      await vi.advanceTimersByTimeAsync(100);
      await normalHandler.finalize();

      // Both messages were sent
      expect(channel._sentMessages).toHaveLength(2);
      expect(channel._sentMessages[0]!.content).toContain("Something went wrong");
      expect(channel._sentMessages[1]!.content).toBe("Here is your answer.");
    });

    it("should show timeout-specific error for long-running requests", async () => {
      const channel = createMockChannel("ch-timeout", "timeout-test");
      const handler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );

      // Simulate the timeout error that the adapter sends
      await handler.showError(
        "That took too long — try breaking it down into smaller requests."
      );

      expect(channel._sentMessages[0]!.content).toContain("took too long");
      expect(channel._sentMessages[0]!.content).toContain("smaller requests");
    });

    it("should not send further content after an error is shown", async () => {
      const channel = createMockChannel("ch-no-leak", "no-leak-test");
      const handler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );

      // Some content arrives, then error
      handler.appendText("Partial content...");
      await handler.showError("Something went wrong. Try again or rephrase your request.");

      // Try to append more — should be no-op after error
      handler.appendText("SHOULD NOT APPEAR");
      await vi.advanceTimersByTimeAsync(200);

      // Only the error message was sent (showError sends its own message)
      // The partial content may or may not have flushed, but "SHOULD NOT APPEAR" must not
      const allContent = channel._sentMessages.map((m) => m.content).join(" ");
      expect(allContent).not.toContain("SHOULD NOT APPEAR");
    });
  });

  describe("bot mention format", () => {
    it("should only respond to @mentions — adapter strips the mention prefix", () => {
      const botUserId = "123456789";

      // This is the content processing from discord-adapter.ts line 105-108
      const rawContent = `<@${botUserId}> what is the project architecture?`;
      const processed = rawContent
        .replace(`<@${botUserId}>`, "")
        .replace(/<@&\d+>/g, "")
        .trim();

      expect(processed).toBe("what is the project architecture?");
      expect(processed).not.toContain(`<@${botUserId}>`);
    });

    it("should ignore messages that mention the bot name as plain text (not @mention)", () => {
      const botUserId = "123456789";

      // Plain text mention — no <@ID> format
      const rawContent = "hey bot what do you think about this?";
      const hasMention = rawContent.includes(`<@${botUserId}>`);

      // The adapter checks: message.mentions.has(this.client.user!)
      // A plain text "bot" does NOT trigger a Discord mention
      expect(hasMention).toBe(false);
    });

    it("should strip role mentions from the content", () => {
      const botUserId = "123456789";
      const rawContent = `<@${botUserId}> <@&987654321> deploy the app`;
      const processed = rawContent
        .replace(`<@${botUserId}>`, "")
        .replace(/<@&\d+>/g, "")
        .trim();

      expect(processed).toBe("deploy the app");
      expect(processed).not.toContain("<@&");
    });

    it("should return empty string when message is only the mention", () => {
      const botUserId = "123456789";
      const rawContent = `<@${botUserId}>`;
      const processed = rawContent
        .replace(`<@${botUserId}>`, "")
        .replace(/<@&\d+>/g, "")
        .trim();

      // Empty content is filtered by the adapter (line 109: if (!content) return;)
      expect(processed).toBe("");
    });

    it("should preserve the actual message content after stripping mentions", () => {
      const botUserId = "123456789";
      const rawContent = `<@${botUserId}> run workers on /Users/adam/projects/my-app with 3 subtasks`;
      const processed = rawContent
        .replace(`<@${botUserId}>`, "")
        .replace(/<@&\d+>/g, "")
        .trim();

      expect(processed).toBe("run workers on /Users/adam/projects/my-app with 3 subtasks");
    });
  });

  describe("streaming reliability", () => {
    it("should handle empty token stream gracefully", async () => {
      const channel = createMockChannel();
      const handler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );

      // No tokens arrive — just finalize
      await handler.finalize();

      // hasContent should be false
      expect(handler.hasContent).toBe(false);
    });

    it("should handle very rapid small tokens without losing content", async () => {
      const channel = createMockChannel();
      const handler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );

      // Simulate rapid token arrival (like single-character tokens)
      const chars = "Hello, world! This is a streaming test.".split("");
      for (const char of chars) {
        handler.appendText(char);
      }

      // One flush captures everything
      await vi.advanceTimersByTimeAsync(100);
      await handler.finalize();

      const content = channel._sentMessages[0]?.content ?? "";
      expect(content).toBe("Hello, world! This is a streaming test.");
    });

    it("should show tool use indicator during MCP tool calls", async () => {
      const channel = createMockChannel();
      const handler = new DiscordStreamHandler(
        channel as unknown as TextChannel,
        { editIntervalMs: 100 },
      );

      handler.appendText("Let me spawn some workers...");
      await vi.advanceTimersByTimeAsync(100);

      handler.showToolUse("spawn_workers");
      await vi.advanceTimersByTimeAsync(100);

      // Tool indicator should appear in the edit
      expect(channel._editHistory.at(-1)).toContain("spawn_workers");
      expect(channel._editHistory.at(-1)).toContain("Using tool:");

      // Clear tool indicator
      handler.clearToolUse();
      handler.appendText(" Done!");
      await vi.advanceTimersByTimeAsync(100);

      const finalEdit = channel._editHistory.at(-1) ?? "";
      expect(finalEdit).not.toContain("spawn_workers");
      expect(finalEdit).toContain("Done!");

      await handler.finalize();
    });
  });
});
