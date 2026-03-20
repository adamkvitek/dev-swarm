import { log } from "../logger.js";
import { StreamingClaudeSession } from "./streaming-cli.js";

/**
 * Manages per-channel streaming Claude sessions.
 *
 * Each Discord channel gets its own StreamingClaudeSession with:
 *   - Persistent session ID (via --resume) so conversation context
 *     carries across messages in the same channel
 *   - Shared Claude CLI args, system prompt, and MCP config
 *
 * Drop-in replacement for the Map<string, ClaudeSession> pattern
 * in the existing discord-adapter.ts, but with streaming support.
 */
export class SessionManager {
  private sessions = new Map<string, StreamingClaudeSession>();
  private claudeCli: string;
  private extraArgs: string[];
  private mcpConfigPath: string | null;
  private systemPrompt: string | null;

  constructor(options: {
    claudeCli: string;
    extraArgs?: string[];
    mcpConfigPath?: string;
    systemPrompt?: string;
  }) {
    this.claudeCli = options.claudeCli;
    this.extraArgs = options.extraArgs ?? [];
    this.mcpConfigPath = options.mcpConfigPath ?? null;
    this.systemPrompt = options.systemPrompt ?? null;
  }

  /**
   * Get or create a streaming session for a channel.
   * The session persists across messages — each subsequent send()
   * automatically uses --resume with the stored session ID.
   */
  getOrCreate(channelId: string): StreamingClaudeSession {
    let session = this.sessions.get(channelId);
    if (!session) {
      session = new StreamingClaudeSession(
        this.claudeCli,
        this.extraArgs,
        this.mcpConfigPath ?? undefined,
        this.systemPrompt ?? undefined,
      );
      this.sessions.set(channelId, session);
      log.adapter.info({ channelId }, "Created new streaming session");
    }
    return session;
  }

  /**
   * Reset a channel's session (e.g., after unrecoverable error).
   * Next message will start a fresh conversation.
   */
  reset(channelId: string): void {
    this.sessions.delete(channelId);
    log.adapter.info({ channelId }, "Reset streaming session");
  }

  /**
   * Check if a channel has an active session with context.
   */
  hasSession(channelId: string): boolean {
    const session = this.sessions.get(channelId);
    return session?.isActive ?? false;
  }

  /**
   * Get the session ID for a channel (if it exists).
   * Useful for logging/debugging.
   */
  getSessionId(channelId: string): string | null {
    return this.sessions.get(channelId)?.id ?? null;
  }

  /**
   * Update the system prompt used for new sessions.
   * Does NOT affect existing sessions (they already have their prompt).
   */
  updateSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt;
  }

  /**
   * Update the MCP config path.
   * Only affects newly created sessions.
   */
  updateMcpConfigPath(path: string): void {
    this.mcpConfigPath = path;
  }

  /**
   * Get count of active sessions (channels with conversation history).
   */
  get activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.isActive) count++;
    }
    return count;
  }

  /**
   * Clear all sessions. Used during shutdown.
   */
  clear(): void {
    this.sessions.clear();
    log.adapter.info("All streaming sessions cleared");
  }
}
