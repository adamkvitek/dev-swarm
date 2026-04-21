import { spawn } from "node:child_process";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SIGKILL_DELAY_MS = 10_000; // 10s after SIGTERM before SIGKILL

/**
 * Spawns a CLI tool and captures its output.
 * Sends the prompt via stdin to avoid shell argument length limits.
 * Always closes stdin to prevent child processes from hanging.
 * Supports AbortSignal for external cancellation.
 */
export function runCli(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; cwd?: string; stdin?: string; signal?: AbortSignal }
): Promise<CliResult> {

  const timeoutMs = options?.timeoutMs ?? 300_000; // 5 min default

  return new Promise((resolve, reject) => {
    // Check if already aborted before spawning
    if (options?.signal?.aborted) {
      reject(new Error("CLI aborted before start"));
      return;
    }

    const proc = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    function settle(
      fn: typeof resolve | typeof reject,
      value: CliResult | Error,
    ): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      (fn as (v: unknown) => void)(value);
    }

    /**
     * Sends SIGTERM, then escalates to SIGKILL if the process doesn't exit.
     */
    function killProcess(reason: string): void {
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, SIGKILL_DELAY_MS);
      killTimer.unref();
      proc.on("close", () => clearTimeout(killTimer));
      settle(reject, new Error(reason));
    }

    const timer = setTimeout(() => {
      killProcess(`CLI timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`);
    }, timeoutMs);

    // External abort signal
    function onAbort(): void {
      killProcess(`CLI aborted: ${command} ${args.join(" ")}`);
    }
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup(): void {
      options?.signal?.removeEventListener("abort", onAbort);
    }

    const MAX_STDOUT = 10_485_760; // 10MB — workers can produce large output
    proc.stdout.on("data", (data: Buffer) => {
      if (stdout.length < MAX_STDOUT) {
        stdout += data.toString();
        if (stdout.length > MAX_STDOUT) {
          stdout = stdout.slice(0, MAX_STDOUT) + "\n[stdout truncated at 10MB]";
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

    proc.on("close", (code) => {
      settle(resolve, { stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      settle(reject, new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    // Suppress EPIPE if process exits before stdin is fully written/closed
    proc.stdin.on("error", () => {});

    // Write stdin content if provided, then always close stdin to prevent hangs
    if (options?.stdin) {
      proc.stdin.write(options.stdin);
    }
    proc.stdin.end();
  });
}
