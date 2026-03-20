/**
 * Types for Claude CLI `--output-format stream-json` NDJSON events.
 *
 * The CLI outputs one JSON object per line. We only parse the event types
 * we need for streaming to Discord — unknown types are silently skipped.
 *
 * Key events:
 *   content_block_delta (text_delta) → accumulate text tokens
 *   content_block_start (tool_use)  → show tool indicator in Discord
 *   result                          → session ID for --resume, cost/duration
 */

// --- Raw stream-json event shapes (what the CLI outputs) ---

export interface StreamTextDelta {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "text_delta";
    text: string;
  };
}

export interface StreamToolUseStart {
  type: "content_block_start";
  index: number;
  content_block: {
    type: "tool_use";
    id: string;
    name: string;
  };
}

export interface StreamContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface StreamResult {
  type: "result";
  subtype: string;
  session_id: string;
  result: string;
  cost_usd: number;
  total_cost_usd: number;
  duration_ms: number;
  total_duration_ms: number;
  is_error: boolean;
  num_turns: number;
}

// --- Parsed events emitted to consumers ---

export type StreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use_start"; toolName: string }
  | { kind: "tool_use_end" }
  | { kind: "result"; result: StreamResult }
  | { kind: "error"; error: Error };

// --- Session types ---

export interface StreamSessionResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  isError: boolean;
  numTurns: number;
}

// --- Callbacks for streaming consumers ---

export interface StreamCallbacks {
  onTextDelta: (text: string) => void;
  onToolUseStart: (toolName: string) => void;
  onToolUseEnd: () => void;
}
