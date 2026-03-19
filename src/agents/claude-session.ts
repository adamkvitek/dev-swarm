import { runCli } from "./cli-runner.js";
import { claudeSessionResponseSchema, parseCliJson } from "./schemas.js";

export interface SessionResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
}

/**
 * Persistent Claude CLI session.
 * First call creates a new session; subsequent calls resume it with full context.
 * Uses `claude --print --output-format json --resume <id>` under the hood.
 *
 * System prompt is passed via --append-system-prompt (proper flag),
 * NOT mixed into the user message via stdin.
 */
export class ClaudeSession {
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

  async send(
    prompt: string,
    options?: { timeoutMs?: number }
  ): Promise<SessionResult> {
    const timeoutMs = options?.timeoutMs ?? 600_000; // 10 min default

    const args = [
      "--print",
      "--output-format", "json",
      ...this.extraArgs,
    ];

    // System prompt via proper flag — only on first message (session remembers it)
    if (this.systemPrompt && !this.sessionId) {
      args.push("--append-system-prompt", this.systemPrompt);
    }

    // Add MCP config if available
    if (this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath);
    }

    // Resume existing session
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const result = await runCli(this.claudeCli, args, {
      timeoutMs,
      stdin: prompt,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Claude session failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
    }

    // Parse and validate JSON response
    const parsed = parseCliJson(result.stdout, claudeSessionResponseSchema);
    if ("error" in parsed) {
      throw new Error(`Claude response parsing failed: ${parsed.error}`);
    }

    // Save session ID for resume
    this.sessionId = parsed.data.session_id;

    return {
      text: parsed.data.result,
      sessionId: parsed.data.session_id,
      costUsd: parsed.data.total_cost_usd,
      durationMs: parsed.data.duration_ms,
    };
  }
}
