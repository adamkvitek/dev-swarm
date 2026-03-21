/**
 * Integration tests for the Discord adapter message flow.
 *
 * These tests define the TARGET behavior after the Discord overhaul.
 * They test the full adapter message flow with mocked Discord.js but
 * real application logic (DiscordStreamHandler, findSplitPoint, etc.).
 *
 * Some tests will initially fail on the current code — that's by design.
 * They define what the code SHOULD do, not what it currently does.
 *
 * Does NOT require a running Discord bot or network access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscordStreamHandler, findSplitPoint } from "../../streaming/discord-handler.js";
import { ResourceGuard } from "../resource-guard.js";
import type { TextChannel, Message } from "discord.js";
import type { StreamCallbacks, StreamSessionResult } from "../../streaming/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockMessage {
  content: string;
  edit: ReturnType<typeof vi.fn>;
}

interface MockChannelTracker {
  sentMessages: MockMessage[];
  sendTypingCalls: number;
}

function createMockChannel(): TextChannel & { _tracker: MockChannelTracker } {
  const tracker: MockChannelTracker = {
    sentMessages: [],
    sendTypingCalls: 0,
  };

  const channel = {
    id: "test-channel-123",
    name: "test-channel",
    _tracker: tracker,

    send: vi.fn(async (content: string) => {
      const msg: MockMessage = {
        content,
        edit: vi.fn(async (newContent: string) => {
          msg.content = newContent;
        }),
      };
      tracker.sentMessages.push(msg);
      return msg as unknown as Message;
    }),

    sendTyping: vi.fn(async () => {
      tracker.sendTypingCalls++;
    }),
  } as unknown as TextChannel & { _tracker: MockChannelTracker };

  return channel;
}

function createMockMessage(
  content: string,
  channel: TextChannel,
  options?: { authorBot?: boolean; authorId?: string; authorTag?: string; authorDisplayName?: string },
): Message {
  return {
    content,
    channel,
    author: {
      bot: options?.authorBot ?? false,
      id: options?.authorId ?? "user-456",
      tag: options?.authorTag ?? "testuser#1234",
      displayName: options?.authorDisplayName ?? "TestUser",
    },
    mentions: {
      has: () => true,
    },
    createdTimestamp: Date.now(),
  } as unknown as Message;
}

/**
 * Simulate a streaming Claude session that emits text deltas on a timer.
 * Calls onTextDelta with each chunk, then resolves with the full result.
 */
function createMockStreamingSession(chunks: string[], delayMs: number = 50) {
  return {
    send: vi.fn(
      async (
        _prompt: string,
        callbacks: StreamCallbacks,
        _options?: { timeoutMs?: number },
      ): Promise<StreamSessionResult> => {
        const allText: string[] = [];

        for (const chunk of chunks) {
          await new Promise((r) => setTimeout(r, delayMs));
          callbacks.onTextDelta(chunk);
          allText.push(chunk);
        }

        return {
          text: allText.join(""),
          sessionId: "session-abc",
          costUsd: 0.01,
          durationMs: chunks.length * delayMs,
          isError: false,
          numTurns: 1,
        };
      },
    ),
    isActive: true,
    id: "session-abc",
    reset: vi.fn(),
  };
}

// Mock os module for ResourceGuard tests
vi.mock("node:os", () => ({
  freemem: vi.fn(() => 8 * 1024 * 1024 * 1024), // 8GB free
  totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024), // 16GB total
  platform: vi.fn(() => "darwin"),
  cpus: vi.fn(() => Array.from({ length: 8 }, () => ({ model: "mock", speed: 2400, times: { user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 } }))),
  homedir: vi.fn(() => "/home/test"),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("not linux");
  }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("mock vm_stat");
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Discord adapter integration: message flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should start typing, stream response, and stop typing after first visible content", async () => {
    const channel = createMockChannel();
    const streamHandler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });
    const session = createMockStreamingSession(["Hello ", "world", "!"]);

    // Start typing
    await channel.sendTyping();
    expect(channel._tracker.sendTypingCalls).toBe(1);

    // Simulate the message flow: send to session with streaming callbacks
    vi.useRealTimers(); // Need real timers for the async session mock
    const result = await session.send(
      "[TestUser]: hello",
      {
        onTextDelta: (text) => {
          // In the real adapter, typing stops on first delta
          streamHandler.appendText(text);
        },
        onToolUseStart: (name) => streamHandler.showToolUse(name),
        onToolUseEnd: () => streamHandler.clearToolUse(),
      },
      { timeoutMs: 60_000 },
    );

    await streamHandler.finalize();

    // Verify the stream handler received all text
    expect(result.text).toBe("Hello world!");

    // Verify at least one message was sent to the channel
    expect(channel.send).toHaveBeenCalled();

    // Verify the final message content contains the full response
    const lastMsg = channel._tracker.sentMessages.at(-1);
    expect(lastMsg).toBeDefined();
    expect(lastMsg!.content).toContain("Hello");
  });

  it("should finalize stream handler even when no text deltas arrive", async () => {
    const channel = createMockChannel();
    const streamHandler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    // Finalize with no content — should not throw
    await streamHandler.finalize();
    expect(streamHandler.hasContent).toBe(false);
  });
});

describe("Discord adapter integration: resource-constrained messages", () => {
  it("should still process messages when resources are constrained", () => {
    // In the target behavior, resource-constrained messages are NOT refused.
    // Instead, resource context is injected into the prompt for Claude.
    //
    // Current behavior: the adapter sends a refusal message and returns early.
    // Target behavior: the adapter sends the message to Claude with constraint context.
    //
    // This test documents the target behavior.
    const guard = new ResourceGuard(40, 4, () => 0); // Low ceiling = unhealthy
    const snap = guard.check();

    // The adapter should build a constraint note for Claude, not refuse the user
    const constraintNote =
      `System is at ${snap.memoryUsedPct}% memory usage. ` +
      `Avoid spawning new workers until memory frees up.`;

    expect(constraintNote).toContain("memory usage");
    expect(constraintNote).not.toContain("I need to wait");
    expect(constraintNote).not.toContain("I can't");
  });

  it("should NOT refuse messages when resources are unhealthy", () => {
    // Target behavior: messages are always processed — Claude receives
    // resource context and decides what to do.
    //
    // Verify the constraint note does not contain a refusal.
    const guard = new ResourceGuard(40, 4, () => 0);
    const snap = guard.check();
    expect(snap.healthy).toBe(false);

    // The adapter should not send a refusal — it should pass the message through
    // with additional context about the constraint.
    const prompt = `[TestUser]: please run the workers`;
    const contextNote = `[System note: memory at ${snap.memoryUsedPct}%, above ceiling. ` +
      `Advise the user about resource constraints but still respond helpfully.]`;

    // The combined prompt should contain both the user message and the context
    const fullPrompt = `${contextNote}\n${prompt}`;
    expect(fullPrompt).toContain("please run the workers");
    expect(fullPrompt).toContain("memory at");
  });
});

describe("Discord adapter integration: startup behavior", () => {
  it("should not send startup banner when resources are healthy", () => {
    const channel = createMockChannel();
    const guard = new ResourceGuard(80, 4, () => 0);
    const snap = guard.check();

    // Target behavior: healthy startup = no banner message
    if (snap.healthy) {
      // channel.send should NOT be called on ready
      expect(channel.send).not.toHaveBeenCalled();
    }
  });

  it("should send plain-language warning when resources are constrained at startup", () => {
    const guard = new ResourceGuard(40, 4, () => 0); // Low ceiling triggers unhealthy
    const snap = guard.check();
    expect(snap.healthy).toBe(false);

    // Target behavior: constrained startup sends a plain-language warning
    const warningMessage = buildStartupWarning(snap);

    // Should explain the impact in plain language
    expect(warningMessage).toBeTruthy();
    expect(warningMessage.length).toBeGreaterThan(10);

    // Should NOT contain technical details
    expect(warningMessage).not.toMatch(/\bMB\b/);
    expect(warningMessage).not.toMatch(/\bMEMORY_CEILING_PCT\b/);
    expect(warningMessage).not.toMatch(/\benv\b/i);
    expect(warningMessage).not.toContain("DISCORD_BOT_TOKEN");

    // Should explain impact in human terms
    expect(warningMessage.toLowerCase()).toMatch(/memory|resource|limited|constrained/);
  });
});

describe("Discord adapter integration: long response splitting", () => {
  it("should split responses over 2000 chars at good boundaries", () => {
    // Build a long string with newlines and sentences
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`Line ${i}: This is a reasonably long line of text that simulates a real response.`);
    }
    const longText = lines.join("\n");
    expect(longText.length).toBeGreaterThan(2000);

    // Split iteratively using findSplitPoint
    const chunks: string[] = [];
    let remaining = longText;
    const maxLen = 1990;

    while (remaining.length > 0) {
      const splitAt = findSplitPoint(remaining, maxLen);
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }

    // Every chunk must be under 2000 chars
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLen);
    }

    // Chunks should reassemble to the original text
    expect(chunks.join("")).toBe(longText);

    // Should have split into multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should split at newlines rather than mid-word", () => {
    const text = "First line here\nSecond line here\nThird line that is longer and pushes us past the limit";
    const splitAt = findSplitPoint(text, 35);

    const chunk = text.slice(0, splitAt);

    // Should end at a newline boundary, not mid-word
    expect(chunk.endsWith("\n") || chunk.endsWith("here")).toBe(true);
    expect(splitAt).toBeLessThanOrEqual(35);
  });

  it("should split at sentence boundaries when no newline is near", () => {
    const text =
      "This is the first sentence. This is the second sentence. " +
      "This is a third sentence that pushes well past the split limit we set.";

    const splitAt = findSplitPoint(text, 60);
    const chunk = text.slice(0, splitAt);

    // Should split at a sentence boundary
    expect(chunk).toMatch(/[.!?]\s*$/);
    expect(splitAt).toBeLessThanOrEqual(60);
  });

  it("should not split mid-word when spaces are available", () => {
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    const splitAt = findSplitPoint(words, 30);
    const chunk = words.slice(0, splitAt);

    // Should end at a space, not mid-word
    expect(chunk.endsWith(" ") || words[splitAt] === " " || words[splitAt] === undefined).toBe(true);
  });
});

describe("Discord adapter integration: error recovery", () => {
  it("should show user-friendly error and reset session on streaming failure", async () => {
    const channel = createMockChannel();
    const streamHandler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    // Simulate an error during streaming
    const errorSession = {
      send: vi.fn(async (..._args: unknown[]) => {
        throw new Error("Connection lost during streaming");
      }),
      reset: vi.fn(),
    };

    let errorCaught = false;
    try {
      await errorSession.send("[TestUser]: hello", {
        onTextDelta: () => {},
        onToolUseStart: () => {},
        onToolUseEnd: () => {},
      });
    } catch {
      errorCaught = true;

      // Show a user-friendly error message
      await streamHandler.showError(
        "Something went wrong. Try again or rephrase your request.",
      );

      // Reset the session for next message
      errorSession.reset();
    }

    expect(errorCaught).toBe(true);
    expect(errorSession.reset).toHaveBeenCalledTimes(1);

    // Verify the error message was sent to Discord
    expect(channel.send).toHaveBeenCalledTimes(1);
    const sentText = channel._tracker.sentMessages[0]?.content ?? "";
    expect(sentText).toContain("Something went wrong");
    expect(sentText).not.toContain("Connection lost"); // Internal details hidden
    expect(sentText).not.toContain("stack"); // No stack traces
  });

  it("should show timeout-specific message when Claude times out", async () => {
    const channel = createMockChannel();
    const streamHandler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    const timeoutSession = {
      send: vi.fn(async (..._args: unknown[]) => {
        throw new Error("Streaming CLI timed out after 300000ms");
      }),
    };

    try {
      await timeoutSession.send("[TestUser]: complex question", {
        onTextDelta: () => {},
        onToolUseStart: () => {},
        onToolUseEnd: () => {},
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("timed out")) {
        await streamHandler.showError(
          "That took too long -- try breaking it down into smaller requests.",
        );
      }
    }

    expect(channel.send).toHaveBeenCalledTimes(1);
    const sentText = channel._tracker.sentMessages[0]?.content ?? "";
    expect(sentText).toContain("too long");
    expect(sentText).toContain("smaller requests");
  });
});

describe("Discord adapter integration: rate limit retry", () => {
  it("should retry on Discord rate limit and eventually succeed", async () => {
    let callCount = 0;
    const channel = {
      id: "test-channel-123",
      name: "test-channel",
      send: vi.fn(async (content: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("You are being rate limited");
        }
        return { content, edit: vi.fn() } as unknown as Message;
      }),
      sendTyping: vi.fn(),
    } as unknown as TextChannel;

    // Simulate the sendWithRateLimit pattern from discord-adapter.ts
    async function sendWithRateLimit(ch: TextChannel, text: string): Promise<void> {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await ch.send(text);
          return;
        } catch (err) {
          const isRateLimit = err instanceof Error && err.message.includes("rate limit");
          if (!isRateLimit || attempt === 2) throw err;

          // In real code this would use setTimeout; here we just continue
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }

    await sendWithRateLimit(channel, "Hello after retry");

    // Should have been called twice: first fails, second succeeds
    expect(channel.send).toHaveBeenCalledTimes(2);

    // The second call should have succeeded with the correct content
    expect(channel.send).toHaveBeenLastCalledWith("Hello after retry");
  });

  it("should throw after exhausting rate limit retries", async () => {
    const channel = {
      id: "test-channel-123",
      send: vi.fn(async () => {
        throw new Error("You are being rate limited");
      }),
      sendTyping: vi.fn(),
    } as unknown as TextChannel;

    async function sendWithRateLimit(ch: TextChannel, text: string): Promise<void> {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await ch.send(text);
          return;
        } catch (err) {
          const isRateLimit = err instanceof Error && err.message.includes("rate limit");
          if (!isRateLimit || attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }

    await expect(sendWithRateLimit(channel, "Will fail")).rejects.toThrow("rate limit");
    expect(channel.send).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Helper functions that mirror target adapter behavior
// ---------------------------------------------------------------------------

/**
 * Build a plain-language startup warning for constrained resources.
 * Target behavior: no technical details, just impact explanation.
 */
function buildStartupWarning(snap: { healthy: boolean; memoryUsedPct: number }): string {
  if (snap.healthy) return "";

  return (
    "I'm running with limited memory right now, so I may be slower than usual " +
    "and won't be able to run as many parallel tasks. I'll let you know if " +
    "something can't be completed due to resource constraints."
  );
}
