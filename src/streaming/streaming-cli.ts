import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../logger.js";
import type {
  StreamCallbacks,
  StreamSessionResult,
  StreamTextDelta,
  StreamToolUseStart,
  StreamResult,
} from "./types.js";

const SIGKILL_DELAY_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min

/**
 * Persistent Claude CLI session with streaming output.
 *
 * Uses `claude --print --output-format stream-json` to get NDJSON token stream.
 * Parses each line and invokes callbacks for text deltas and tool use events.
 * Returns the final result when the stream completes.
 *
 * Session persistence: captures `session_id` from the result event and
 * uses `--resume <id>` on subsequent calls — same pattern as ClaudeSession
 * but with streaming instead of buffered output.
 */
export class StreamingClaudeSession {
  private sessionId: string | null = null;
  private claudeCli: string;
  private extraArgs: string[];
  private mcpConfigPath: string | null;
  private systemPrompt: string | null;

  constructor(
    claudeCli: string,
    extraArgs: string[] = [],
    mcpConfigPath?: string,
    systemPrompt?: string,
  ) {
    this.claudeCli = claudeCli;
    this.extraArgs = extraArgs;
    this.mcpConfigPath = mcpConfigPath ?? null;
    this.systemPrompt = systemPrompt ?? null;
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get id(): string | null {
    return this.sessionId;
  }

  reset(): void {
    this.sessionId = null;
  }

  /**
   * Send a message and stream the response.
   *
   * Callbacks fire as tokens arrive:
   *   onTextDelta  — each text token (often a word or partial word)
   *   onToolUseStart — when Claude invokes an MCP tool
   *   onToolUseEnd   — when a tool_use content block completes
   *
   * Returns a promise that resolves with the final session result
   * (text, sessionId, cost, duration) when the CLI process exits.
   */
  async send(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<StreamSessionResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const args = this.buildArgs();

    log.adapter.info(
      { sessionId: this.sessionId, hasSystemPrompt: !!this.systemPrompt && !this.sessionId },
      "Streaming session send",
    );

    return new Promise<StreamSessionResult>((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error("Streaming session aborted before start"));
        return;
      }

      const spawnTime = Date.now();

      const proc = spawn(this.claudeCli, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      let settled = false;
      let accumulatedText = "";
      let streamResult: StreamResult | null = null;
      let firstDataTime: number | null = null;
      // Track which content block indices are tool_use blocks
      const toolUseIndices = new Set<number>();

      const settle = (
        fn: typeof resolve | typeof reject,
        value: StreamSessionResult | Error,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        (fn as (v: unknown) => void)(value);
      };

      const killProcess = (reason: string): void => {
        proc.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          proc.kill("SIGKILL");
        }, SIGKILL_DELAY_MS);
        killTimer.unref();
        proc.on("close", () => clearTimeout(killTimer));
        settle(reject, new Error(reason));
      };

      const timer = setTimeout(() => {
        killProcess(`Streaming CLI timed out after ${timeoutMs}ms`);
      }, timeoutMs);

      const onAbort = (): void => {
        killProcess("Streaming session aborted");
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        options?.signal?.removeEventListener("abort", onAbort);
      };

      // Line buffer for NDJSON parsing — stdout arrives as chunks, not lines
      let lineBuffer = "";

      proc.stdout.on("data", (data: Buffer) => {
        if (firstDataTime === null) {
          firstDataTime = Date.now();
          log.adapter.info(
            { sessionId: this.sessionId, spawnToFirstDataMs: firstDataTime - spawnTime },
            "Streaming CLI first stdout data",
          );
        }
        lineBuffer += data.toString();
        const lines = lineBuffer.split("\n");
        // Keep the last incomplete line in the buffer
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const event = parseStreamLine(trimmed);
          if (!event) continue;

          switch (event.type) {
            case "content_block_delta": {
              if (event.delta.type === "text_delta") {
                accumulatedText += event.delta.text;
                callbacks.onTextDelta(event.delta.text);
              }
              break;
            }
            case "content_block_start": {
              if (event.content_block.type === "tool_use") {
                toolUseIndices.add(event.index);
                callbacks.onToolUseStart(event.content_block.name);
              }
              break;
            }
            case "content_block_stop": {
              if (toolUseIndices.has(event.index)) {
                toolUseIndices.delete(event.index);
                callbacks.onToolUseEnd();
              }
              break;
            }
            case "result": {
              streamResult = event;
              break;
            }
          }
        }
      });

      const MAX_STDERR = 1_048_576; // 1MB
      proc.stderr.on("data", (data: Buffer) => {
        if (stderr.length < MAX_STDERR) {
          stderr += data.toString();
          if (stderr.length > MAX_STDERR) {
            stderr = stderr.slice(0, MAX_STDERR) + "\n[stderr truncated at 1MB]";
          }
        }
      });

      // Suppress EPIPE if process exits before stdin is fully written
      proc.stdin.on("error", () => {});

      proc.on("close", (code) => {
        // Process any remaining data in the line buffer
        if (lineBuffer.trim()) {
          const event = parseStreamLine(lineBuffer.trim());
          if (event?.type === "result") {
            streamResult = event;
          }
        }

        if (code !== 0 && !streamResult) {
          settle(
            reject,
            new Error(
              `Streaming CLI failed (exit ${code}): ${stderr.slice(0, 300)}`,
            ),
          );
          return;
        }

        // Build the result — prefer streamResult, fall back to accumulated text
        const sessionId = streamResult?.session_id ?? this.sessionId ?? "";
        this.sessionId = sessionId || this.sessionId;

        const totalElapsedMs = Date.now() - spawnTime;
        const firstDataToResultMs = firstDataTime !== null ? Date.now() - firstDataTime : null;
        log.adapter.info(
          {
            sessionId,
            totalElapsedMs,
            spawnToFirstDataMs: firstDataTime !== null ? firstDataTime - spawnTime : null,
            firstDataToResultMs,
            cliDurationMs: streamResult?.total_duration_ms ?? null,
          },
          "Streaming CLI completed",
        );

        settle(resolve, {
          text: streamResult?.result ?? accumulatedText,
          sessionId,
          costUsd: streamResult?.total_cost_usd ?? 0,
          durationMs: streamResult?.total_duration_ms ?? 0,
          isError: streamResult?.is_error ?? (code !== 0),
          numTurns: streamResult?.num_turns ?? 1,
        });
      });

      proc.on("error", (err) => {
        settle(
          reject,
          new Error(`Failed to spawn streaming CLI: ${err.message}`),
        );
      });

      // Write prompt via stdin, then close
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  private buildArgs(): string[] {
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      ...this.extraArgs,
    ];

    // System prompt via proper flag — only on first message (session remembers it)
    if (this.systemPrompt && !this.sessionId) {
      args.push("--append-system-prompt", this.systemPrompt);
    }

    // MCP config for tool access
    if (this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath);
    }

    // Resume existing session
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    return args;
  }
}

// --- NDJSON line parsing ---

type ParsedEvent =
  | (StreamTextDelta & { type: "content_block_delta" })
  | (StreamToolUseStart & { type: "content_block_start" })
  | { type: "content_block_stop"; index: number }
  | (StreamResult & { type: "result" });

/**
 * Parse a single NDJSON line from stream-json output.
 * Returns null for unrecognized or malformed events — we only care about
 * text deltas, tool use starts, content block stops, and the final result.
 */
export function parseStreamLine(line: string): ParsedEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    log.adapter.debug({ line: line.slice(0, 100) }, "Skipping unparseable stream line");
    return null;
  }

  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case "content_block_delta": {
      const delta = obj.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return {
          type: "content_block_delta",
          index: typeof obj.index === "number" ? obj.index : 0,
          delta: { type: "text_delta", text: delta.text },
        };
      }
      return null;
    }

    case "content_block_start": {
      const block = obj.content_block as Record<string, unknown> | undefined;
      if (
        block?.type === "tool_use" &&
        typeof block.name === "string" &&
        typeof block.id === "string"
      ) {
        return {
          type: "content_block_start",
          index: typeof obj.index === "number" ? obj.index : 0,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
          },
        };
      }
      return null;
    }

    case "content_block_stop": {
      return {
        type: "content_block_stop",
        index: typeof obj.index === "number" ? obj.index : 0,
      };
    }

    case "result": {
      return {
        type: "result",
        subtype: typeof obj.subtype === "string" ? obj.subtype : "unknown",
        session_id: typeof obj.session_id === "string" ? obj.session_id : "",
        result: typeof obj.result === "string" ? obj.result : "",
        cost_usd: typeof obj.cost_usd === "number" ? obj.cost_usd : 0,
        total_cost_usd:
          typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
        duration_ms:
          typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
        total_duration_ms:
          typeof obj.total_duration_ms === "number"
            ? obj.total_duration_ms
            : 0,
        is_error: typeof obj.is_error === "boolean" ? obj.is_error : false,
        num_turns: typeof obj.num_turns === "number" ? obj.num_turns : 1,
      };
    }

    default:
      return null;
  }
}
