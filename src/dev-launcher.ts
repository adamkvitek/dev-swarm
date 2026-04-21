import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Launches `tsx watch src/index.ts` piped through `pino-pretty` with proper
 * process lifecycle management.
 *
 * Why this exists: `npm run dev` previously used a shell pipe
 * (`tsx watch src/index.ts | pino-pretty`) which creates a subshell. When the
 * terminal is closed (SIGHUP), macOS doesn't always propagate the signal
 * through the pipe, leaving orphaned Node processes running forever.
 *
 * This launcher spawns both processes in their own process groups (detached),
 * manually pipes stdout, and kills entire process trees on any exit signal.
 */

const tsxCli = resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const pinoPrettyCli = resolve(ROOT, "node_modules", ".bin", "pino-pretty");

// Spawn in own process groups so we can kill entire trees
const tsx = spawn(process.execPath, [tsxCli, "watch", "src/index.ts"], {
  cwd: ROOT,
  stdio: ["inherit", "pipe", "inherit"],
  detached: true,
});

const pretty = spawn(pinoPrettyCli, [], {
  cwd: ROOT,
  stdio: ["pipe", "inherit", "inherit"],
  detached: true,
});

// Pipe tsx stdout → pino-pretty stdin
tsx.stdout.pipe(pretty.stdin);

/**
 * Kill an entire process group — sends signal to all descendants.
 * On POSIX, process.kill(-pid, signal) sends to the process group.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Process may have already exited
    try { child.kill(signal); } catch { /* ignore */ }
  }
}

let exiting = false;
function cleanup(): void {
  if (exiting) return;
  exiting = true;

  killTree(tsx, "SIGTERM");
  killTree(pretty, "SIGTERM");

  // Escalate to SIGKILL after 5s
  setTimeout(() => {
    killTree(tsx, "SIGKILL");
    killTree(pretty, "SIGKILL");
    process.exit(1);
  }, 5_000).unref();
}

tsx.on("close", (code) => {
  killTree(pretty);
  process.exit(code ?? 0);
});

tsx.on("error", (err) => {
  console.error("Failed to start tsx:", err.message);
  cleanup();
  process.exit(1);
});

pretty.on("error", (err) => {
  console.error("Failed to start pino-pretty:", err.message);
  cleanup();
  process.exit(1);
});

// Handle all exit signals — kill entire process trees
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    cleanup();
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
