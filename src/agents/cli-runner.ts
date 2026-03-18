import { spawn } from "node:child_process";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Returns true when running inside a VM that has been explicitly marked
 * safe for OpenClaw execution via the OPENCLAW_VM_CONFIRMED env var.
 */
function isInsideOpenClawVm(): boolean {
  return process.env.OPENCLAW_VM_CONFIRMED === "1";
}

/**
 * Blocks OpenClaw invocations on the host OS.
 *
 * OpenClaw must NEVER run on the host — Baptiste warned it is dangerous.
 * The guard allows execution only when OPENCLAW_VM_CONFIRMED=1 is set,
 * which should only happen inside a dedicated VM.
 */
function assertNotHostOpenClaw(command: string, args: string[]): void {
  const fullCommand = [command, ...args].join(" ").toLowerCase();
  if (!fullCommand.includes("openclaw")) return;

  if (isInsideOpenClawVm()) return;

  throw new Error(
    "BLOCKED: OpenClaw must NEVER run on the host OS. " +
      "It may only be executed inside a dedicated VM with OPENCLAW_VM_CONFIRMED=1. " +
      "See DECISIONS.md and SETUP.md for details."
  );
}

/**
 * Spawns a CLI tool and captures its output.
 * Sends the prompt via stdin to avoid shell argument length limits.
 * Always closes stdin to prevent child processes from hanging.
 */
export function runCli(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; cwd?: string; stdin?: string }
): Promise<CliResult> {
  assertNotHostOpenClaw(command, args);

  const timeoutMs = options?.timeoutMs ?? 300_000; // 5 min default

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
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
