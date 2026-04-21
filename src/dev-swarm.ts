import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Single command launch: starts the server, then opens Claude Code with MCP tools.
 * Works on macOS, Linux, and Windows.
 *
 * Usage: npm run dev-swarm
 */
async function main(): Promise<void> {
  const env = loadEnv();

  // 1. Start the server in the background (no shell — direct Node spawn)
  console.log("Starting dev-swarm server...");
  // Use tsx's CLI entry point directly — avoids platform-specific
  // .bin symlinks (Unix) vs .cmd shims (Windows).
  const tsxCli = resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const server = spawn(process.execPath, [
    "--no-warnings",
    tsxCli,
    resolve(__dirname, "serve.ts"),
  ], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    detached: true, // own process group so we can kill entire tree
  });

  // 2. Wait for health check
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://${env.MCP_API_HOST}:${env.MCP_API_PORT}/health`);
      if (res.ok) { ready = true; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    console.error("Error: server failed to start after 30s");
    if (server.pid) try { process.kill(-server.pid, "SIGKILL"); } catch { /* */ }
    process.exit(1);
  }

  const mcpConfigPath = resolve(ROOT, "mcp-config.json");

  // Short system prompt as CLI arg — full prompt is in prompts/system.md
  // which Claude reads via CLAUDE.md or the MCP server context
  const shortPrompt =
    "You are Daskyleion, a CTO-level AI agent leading a dev swarm. " +
    "You orchestrate work using MCP tools (spawn_workers, spawn_council, spawn_review) " +
    "and native Claude Code Agent tool for parallel work. " +
    "You may read code to understand context. Read prompts/system.md for full instructions.";

  console.log("Server ready. Launching Claude Code...\n");

  // 3. Launch Claude Code — NO shell:true (preserves terminal properly)
  const claude = spawn(env.CLAUDE_CLI, [
    "--mcp-config", mcpConfigPath,
    "--append-system-prompt", shortPrompt,
  ], {
    cwd: ROOT,
    stdio: "inherit",
  });

  // 4. Cleanup: either process dying kills the other
  claude.on("close", (code) => {
    killTree(server);
    process.exit(code ?? 0);
  });

  claude.on("error", (err) => {
    console.error("Failed to launch Claude Code:", err.message);
    console.error("Make sure claude is installed: claude --version");
    killTree(server);
    process.exit(1);
  });

  server.on("close", (code) => {
    if (code !== 0) {
      console.error(`Server exited unexpectedly (code ${code}). Shutting down.`);
      claude.kill("SIGTERM");
      process.exit(1);
    }
  });

  /** Kill an entire process group — sends signal to all descendants. */
  function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    if (child.pid == null) return;
    try { process.kill(-child.pid, signal); } catch { /* already exited */ }
  }

  function killAll(): void {
    killTree(server, "SIGTERM");
    claude.kill("SIGTERM");
    // Escalate after 5s in case graceful shutdown hangs
    setTimeout(() => {
      killTree(server, "SIGKILL");
      claude.kill("SIGKILL");
    }, 5_000).unref();
  }

  // Let Claude handle Ctrl+C — server cleans up when Claude exits
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => killAll());
  process.on("SIGHUP", () => killAll()); // terminal closed — kill everything
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
