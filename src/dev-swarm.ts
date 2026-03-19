import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Single command launch: starts the server, then opens Claude Code with MCP tools.
 * Works on macOS, Linux, and Windows.
 *
 * Usage: npm run dev-swarm
 */
async function main(): Promise<void> {
  // 1. Start the server in the background
  console.log("Starting dev-swarm server...");
  const server = spawn("npx", ["tsx", resolve(__dirname, "serve.ts")], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
    shell: true,
  });

  // 2. Wait for health check
  const healthUrl = "http://127.0.0.1:9847/health";
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) { ready = true; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    console.error("Error: server failed to start after 30s");
    server.kill();
    process.exit(1);
  }

  // 3. Load system prompt and MCP config path
  const mcpConfigPath = resolve(ROOT, "mcp-config.json");
  let systemPrompt: string;
  try {
    systemPrompt = await readFile(resolve(ROOT, "prompts", "system.md"), "utf-8");
  } catch {
    systemPrompt = "You are Daskyleion, a CTO-level AI agent. Use MCP tools to delegate work to your agent team.";
  }

  console.log("Server ready. Launching Claude Code with swarm tools...\n");

  // 4. Launch Claude Code as interactive foreground process
  const claude = spawn("claude", [
    "--mcp-config", mcpConfigPath,
    "--append-system-prompt", systemPrompt,
  ], {
    cwd: ROOT,
    stdio: "inherit", // Full interactive: colors, streaming, keyboard
    shell: true,
  });

  // 5. When Claude exits, stop the server
  claude.on("close", (code) => {
    console.log("\nShutting down server...");
    server.kill();
    process.exit(code ?? 0);
  });

  // Handle Ctrl+C — kill both
  const shutdown = (): void => {
    claude.kill();
    server.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
