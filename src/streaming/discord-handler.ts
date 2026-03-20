import type { TextChannel, Message } from "discord.js";
import { log } from "../logger.js";

const DISCORD_MAX_LENGTH = 1990; // Leave margin below 2000
const DEFAULT_EDIT_INTERVAL_MS = 1500; // ~3 edits per 5s, well under Discord's 5/5s limit
const TOOL_USE_PREFIX = "\n> *Using tool:";

/**
 * Manages streaming text to a Discord channel.
 *
 * Accumulates text deltas from the CLI stream and periodically edits
 * the current Discord message with the latest content. When a message
 * approaches the 2000 char limit, it finalizes that message and creates
 * a new one for continued streaming.
 *
 * Rate limiting: edits at most every ~1.5s (configurable), staying well
 * under Discord's 5 edits per 5 seconds rate limit.
 *
 * Usage:
 *   const handler = new DiscordStreamHandler(channel);
 *   // Called from streaming CLI callbacks:
 *   handler.appendText("Hello ");
 *   handler.appendText("world!");
 *   handler.showToolUse("spawn_workers");
 *   handler.clearToolUse();
 *   // When stream completes:
 *   await handler.finalize();
 */
export class DiscordStreamHandler {
  private channel: TextChannel;
  private editIntervalMs: number;

  // Current message being streamed to
  private currentMessage: Message | null = null;
  // All finalized (full) messages sent so far
  private sentMessages: Message[] = [];

  // Text buffer — what the current message should show
  private buffer = "";
  // Whether we have pending text that hasn't been flushed to Discord yet
  private isDirty = false;
  // The edit interval timer
  private editTimer: ReturnType<typeof setInterval> | null = null;
  // Whether finalize() has been called
  private isFinalized = false;
  // Current tool use indicator (appended to message while active)
  private activeToolName: string | null = null;

  constructor(channel: TextChannel, options?: { editIntervalMs?: number }) {
    this.channel = channel;
    this.editIntervalMs = options?.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
  }

  /**
   * Append streaming text. Call this for each text_delta token.
   * The text is buffered and flushed to Discord on the edit interval.
   */
  appendText(text: string): void {
    if (this.isFinalized) return;

    this.buffer += text;
    this.isDirty = true;
    this.ensureEditTimer();
  }

  /**
   * Show a tool use indicator in the current message.
   * Displayed as: "> *Using tool: tool_name...*"
   */
  showToolUse(toolName: string): void {
    if (this.isFinalized) return;

    this.activeToolName = toolName;
    this.isDirty = true;
    this.ensureEditTimer();
  }

  /**
   * Clear the tool use indicator. Called when tool_use content block stops.
   */
  clearToolUse(): void {
    if (this.isFinalized) return;

    this.activeToolName = null;
    this.isDirty = true;
  }

  /**
   * Finalize the stream — flush any remaining text and stop the edit timer.
   * Must be called when the stream completes (success or error).
   */
  async finalize(): Promise<void> {
    if (this.isFinalized) return;
    this.isFinalized = true;
    this.stopEditTimer();
    this.activeToolName = null;

    // Final flush
    await this.flush();
  }

  /**
   * Show an error message in the channel.
   * Creates a new message (doesn't edit the streamed one) to avoid confusion.
   */
  async showError(message: string): Promise<void> {
    this.isFinalized = true;
    this.stopEditTimer();

    try {
      await this.sendWithRetry(message);
    } catch (err) {
      log.adapter.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to send error message to Discord",
      );
    }
  }

  /** Whether any content has been sent to Discord */
  get hasContent(): boolean {
    return this.currentMessage !== null || this.buffer.length > 0;
  }

  // --- Internal ---

  private ensureEditTimer(): void {
    if (this.editTimer || this.isFinalized) return;
    this.editTimer = setInterval(() => {
      void this.flush();
    }, this.editIntervalMs);
  }

  private stopEditTimer(): void {
    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }
  }

  /**
   * Flush buffered text to Discord — either edit the current message
   * or create a new one if needed.
   */
  private async flush(): Promise<void> {
    if (!this.isDirty && !this.activeToolName) return;
    this.isDirty = false;

    // Build the display text: buffer + optional tool indicator
    const displayText = this.buildDisplayText();
    if (!displayText) return;

    try {
      // Check if we need to split into a new message
      if (displayText.length > DISCORD_MAX_LENGTH) {
        await this.splitAndSend();
        return;
      }

      if (this.currentMessage) {
        // Edit existing message
        await this.currentMessage.edit(displayText);
      } else {
        // Create first message
        this.currentMessage = await this.sendWithRetry(displayText);
      }
    } catch (err) {
      log.adapter.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Discord message flush failed",
      );
    }
  }

  /**
   * Handle messages exceeding the Discord character limit.
   * Finds a good split point, finalizes the current message,
   * and starts a new one.
   */
  private async splitAndSend(): Promise<void> {
    // Find a split point in the buffer at a line or sentence boundary
    const splitAt = findSplitPoint(this.buffer, DISCORD_MAX_LENGTH);
    const chunk = this.buffer.slice(0, splitAt);
    this.buffer = this.buffer.slice(splitAt);

    // Finalize current message with the chunk
    if (this.currentMessage) {
      try {
        await this.currentMessage.edit(chunk || "...");
        this.sentMessages.push(this.currentMessage);
      } catch {
        // If edit fails, send as new message
        const msg = await this.sendWithRetry(chunk || "...");
        if (msg) this.sentMessages.push(msg);
      }
    } else if (chunk) {
      const msg = await this.sendWithRetry(chunk);
      if (msg) this.sentMessages.push(msg);
    }

    // Create new message for remaining content
    const remaining = this.buildDisplayText();
    if (remaining) {
      this.currentMessage = await this.sendWithRetry(remaining);
    } else {
      this.currentMessage = null;
    }
  }

  private buildDisplayText(): string {
    let text = this.buffer;
    if (this.activeToolName) {
      text += `${TOOL_USE_PREFIX} ${this.activeToolName}...*`;
    }
    return text;
  }

  /**
   * Send a message with automatic retry on Discord 429 rate limits.
   * Matches the retry pattern from the existing discord-adapter.ts.
   */
  private async sendWithRetry(text: string): Promise<Message> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.channel.send(text || "_(empty response)_");
      } catch (err) {
        const isRateLimit =
          err instanceof Error && err.message.includes("rate limit");
        if (!isRateLimit || attempt === 2) throw err;

        const delay = (attempt + 1) * 2000;
        log.adapter.warn(
          { delayMs: delay, attempt: attempt + 1 },
          "Discord rate limited on stream message, retrying",
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Unreachable — the loop always returns or throws
    throw new Error("Unexpected: sendWithRetry fell through");
  }
}

/**
 * Find a good split point near maxLen in a text string.
 * Prefers splitting at newlines > sentence boundaries > word boundaries > hard cut.
 */
export function findSplitPoint(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;

  // Try to find a newline near the limit
  const lastNewline = text.lastIndexOf("\n", maxLen);
  if (lastNewline >= maxLen * 0.5) return lastNewline + 1;

  // Try sentence boundary (. ! ?)
  const sentenceEnd = text.slice(0, maxLen).search(/[.!?]\s[^.!?]*$/);
  if (sentenceEnd >= maxLen * 0.5) return sentenceEnd + 2;

  // Try word boundary
  const lastSpace = text.lastIndexOf(" ", maxLen);
  if (lastSpace >= maxLen * 0.5) return lastSpace + 1;

  // Hard cut
  return maxLen;
}
