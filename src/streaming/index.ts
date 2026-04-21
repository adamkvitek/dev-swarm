/**
 * Streaming Discord conversation module.
 *
 * Provides natural streaming conversations in Discord using Claude CLI's
 * `--output-format stream-json` NDJSON output. Messages update live as
 * tokens arrive, like watching Claude think in the terminal.
 *
 * Architecture:
 *   StreamingClaudeSession — spawns CLI, parses NDJSON, emits callbacks
 *   DiscordStreamHandler   — edits Discord messages progressively
 *   SessionManager         — per-channel session persistence via --resume
 */

export { StreamingClaudeSession, parseStreamLine } from "./streaming-cli.js";
export { DiscordStreamHandler, findSplitPoint } from "./discord-handler.js";
export { SessionManager } from "./session-manager.js";
export type {
  StreamEvent,
  StreamSessionResult,
  StreamCallbacks,
  StreamTextDelta,
  StreamToolUseStart,
  StreamResult,
} from "./types.js";
