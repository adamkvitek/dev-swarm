import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscordStreamHandler, findSplitPoint } from "../discord-handler.js";
import type { TextChannel, Message } from "discord.js";

// Mock Discord TextChannel and Message
function createMockChannel(): TextChannel & {
  _sentMessages: Array<{ content: string }>;
  _editHistory: string[];
} {
  const sentMessages: Array<{ content: string; edit: ReturnType<typeof vi.fn> }> = [];
  const editHistory: string[] = [];

  const channel = {
    _sentMessages: sentMessages,
    _editHistory: editHistory,
    send: vi.fn(async (content: string) => {
      const msg = {
        content,
        edit: vi.fn(async (newContent: string) => {
          msg.content = newContent;
          editHistory.push(newContent);
        }),
      };
      sentMessages.push(msg);
      return msg as unknown as Message;
    }),
  } as unknown as TextChannel & {
    _sentMessages: Array<{ content: string }>;
    _editHistory: string[];
  };

  return channel;
}

describe("DiscordStreamHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create a message on first flush", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    handler.appendText("Hello world");

    // Advance timer to trigger flush
    await vi.advanceTimersByTimeAsync(100);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel._sentMessages[0]!.content).toBe("Hello world");
  });

  it("should accumulate text between flushes", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    handler.appendText("Hello ");
    handler.appendText("world");
    handler.appendText("!");

    await vi.advanceTimersByTimeAsync(100);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel._sentMessages[0]!.content).toBe("Hello world!");
  });

  it("should edit existing message on subsequent flushes", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    handler.appendText("Hello");
    await vi.advanceTimersByTimeAsync(100);

    handler.appendText(" world");
    await vi.advanceTimersByTimeAsync(100);

    // First flush creates, second flush edits
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel._editHistory).toHaveLength(1);
    expect(channel._editHistory[0]).toBe("Hello world");
  });

  it("should show tool use indicator", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    handler.appendText("Working on it...");
    await vi.advanceTimersByTimeAsync(100);

    handler.showToolUse("spawn_workers");
    await vi.advanceTimersByTimeAsync(100);

    expect(channel._editHistory.at(-1)).toContain("spawn_workers");
    expect(channel._editHistory.at(-1)).toContain("Using tool:");
  });

  it("should clear tool use indicator", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    handler.appendText("Working...");
    handler.showToolUse("spawn_workers");
    await vi.advanceTimersByTimeAsync(100);

    handler.clearToolUse();
    handler.appendText(" Done!");
    await vi.advanceTimersByTimeAsync(100);

    const lastEdit = channel._editHistory.at(-1) ?? "";
    expect(lastEdit).not.toContain("spawn_workers");
    expect(lastEdit).toContain("Done!");
  });

  it("should finalize and stop the timer", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    handler.appendText("Final text");
    await handler.finalize();

    // After finalize, appendText should be no-op
    handler.appendText("IGNORED");
    await vi.advanceTimersByTimeAsync(200);

    expect(channel._sentMessages[0]!.content).toBe("Final text");
    // Only one send, no edits after finalize
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("should report hasContent correctly", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    expect(handler.hasContent).toBe(false);

    handler.appendText("text");
    expect(handler.hasContent).toBe(true);
  });

  it("should show error message", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    await handler.showError("Something went wrong");

    expect(channel.send).toHaveBeenCalledWith("Something went wrong");
    // After error, handler is finalized
    handler.appendText("IGNORED");
    await vi.advanceTimersByTimeAsync(200);
    // Only the error message was sent
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("should not edit when nothing has changed", async () => {
    const channel = createMockChannel();
    const handler = new DiscordStreamHandler(channel, { editIntervalMs: 100 });

    handler.appendText("Static text");
    await vi.advanceTimersByTimeAsync(100);

    // No new text — next flush should be no-op
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel._editHistory).toHaveLength(0);
  });
});

describe("findSplitPoint", () => {
  it("should return text length when under limit", () => {
    expect(findSplitPoint("short text", 100)).toBe(10);
  });

  it("should split at newline near limit", () => {
    const text = "line one\nline two\nline three\nline four is very long and goes past the limit";
    const splitAt = findSplitPoint(text, 30);
    // Should split at the newline closest to 30 but before it
    expect(text.slice(0, splitAt)).toMatch(/\n$/);
    expect(splitAt).toBeLessThanOrEqual(30);
  });

  it("should split at space when no newline is available", () => {
    const text = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 end";
    const splitAt = findSplitPoint(text, 30);
    expect(splitAt).toBeLessThanOrEqual(31); // +1 for the space
    // Should end at a word boundary
    const chunk = text.slice(0, splitAt);
    expect(chunk.endsWith(" ") || text[splitAt - 1] === " ").toBe(true);
  });

  it("should hard cut when no good boundary exists", () => {
    const text = "a".repeat(100);
    const splitAt = findSplitPoint(text, 50);
    expect(splitAt).toBe(50);
  });

  it("should prefer newline over space", () => {
    const text = "short line\n" + "a".repeat(50);
    const splitAt = findSplitPoint(text, 20);
    expect(text.slice(0, splitAt).trim()).toBe("short line");
  });

  it("should handle text exactly at limit", () => {
    const text = "exactly20characters!";
    expect(findSplitPoint(text, 20)).toBe(20);
  });

  it("should not split too early (past 50% of limit)", () => {
    // Newline at position 5 out of limit 100 — too early, should look for better boundary
    const text = "hi\n" + "x".repeat(200);
    const splitAt = findSplitPoint(text, 100);
    // Should not split at position 3 — that's only 3% of the limit
    expect(splitAt).toBeGreaterThan(50);
  });
});
