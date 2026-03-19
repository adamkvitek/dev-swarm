import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Single command launch: starts the server, then opens Claude Code with MCP tools.
 * Works on macOS, Linux, and Windows.
 *
 * Usage: npm run dev-swarm
 */
async function main(): Promise<void> {
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
    stdio: ["ignore", "pipe", "inherit"],
  });

  // 2. Wait for health check
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9847/health");
      if (res.ok) { ready = true; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    console.error("Error: server failed to start after 30s");
    server.kill();
    process.exit(1);
  }

  const mcpConfigPath = resolve(ROOT, "mcp-config.json");

  // Short system prompt as CLI arg — full prompt is in prompts/system.md
  // which Claude reads via CLAUDE.md or the MCP server context
  const shortPrompt =
    "You are Daskyleion, a CTO-level AI agent leading a dev swarm. " +
    "You MUST delegate all work via MCP tools (spawn_workers, spawn_council, spawn_review). " +
    "Never analyze code yourself. Read prompts/system.md for full instructions.";

  console.log("Server ready. Launching Claude Code...\n");

  // 3. Launch Claude Code — NO shell:true (preserves terminal properly)
  const claude = spawn("claude", [
    "--mcp-config", mcpConfigPath,
    "--append-system-prompt", shortPrompt,
  ], {
    cwd: ROOT,
    stdio: "inherit",
  });

  // 4. Cleanup on exit
  claude.on("close", (code) => {
    server.kill();
    process.exit(code ?? 0);
  });

  claude.on("error", (err) => {
    console.error("Failed to launch Claude Code:", err.message);
    console.error("Make sure claude is installed: claude --version");
    server.kill();
    process.exit(1);
  });

  // Let Claude handle Ctrl+C — server cleans up when Claude exits
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {
    claude.kill("SIGTERM");
    server.kill("SIGTERM");
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
