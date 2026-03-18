import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runCli } from "./cli-runner.js";

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
 */
export class ClaudeSession {
  private sessionId: string | null = null;
  private claudeCli: string;
  private extraArgs: string[];

  constructor(claudeCli: string, extraArgs: string[] = []) {
    this.claudeCli = claudeCli;
    this.extraArgs = extraArgs;
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

    // Write prompt to temp file
    const tmpFile = join(tmpdir(), `session-${randomUUID()}.txt`);
    await writeFile(tmpFile, prompt, "utf-8");

    try {
      const args = [
        "--print",
        "--output-format", "json",
        ...this.extraArgs,
      ];

      // Resume existing session
      if (this.sessionId) {
        args.push("--resume", this.sessionId);
      }

      const result = await runCli("bash", [
        "-c",
        `cat "${tmpFile}" | ${this.claudeCli} ${args.join(" ")}`,
      ], { timeoutMs });

      if (result.exitCode !== 0) {
        throw new Error(`Claude session failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
      }

      // Parse JSON response
      const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`No JSON in Claude response: ${result.stdout.slice(0, 200)}`);
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        result: string;
        session_id: string;
        total_cost_usd: number;
        duration_ms: number;
      };

      // Save session ID for resume
      this.sessionId = parsed.session_id;

      return {
        text: parsed.result,
        sessionId: parsed.session_id,
        costUsd: parsed.total_cost_usd,
        durationMs: parsed.duration_ms,
      };
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  }
}
