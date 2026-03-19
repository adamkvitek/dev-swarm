import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generates the MCP config JSON that Claude CLI uses to start the MCP server.
 *
 * The config tells Claude CLI to spawn our MCP server as a child process
 * using stdio transport, passing the adapter API URL as an environment variable.
 */
export async function generateMcpConfig(
  host: string,
  port: number,
  apiToken: string,
): Promise<string> {
  // Detect whether we're running from src/ (tsx dev mode) or dist/ (compiled).
  // tsx preserves the .ts extension in import.meta.url; compiled JS uses .js.
  const isTsxMode = import.meta.url.endsWith(".ts");
  const serverExt = isTsxMode ? "server.ts" : "server.js";
  const serverPath = resolve(__dirname, "..", "mcp", serverExt);
  const projectRoot = resolve(__dirname, "..", "..");

  // In tsx mode, run tsx's CLI entry point directly via node — this avoids
  // platform-specific .bin symlinks (Unix) vs .cmd shims (Windows).
  // In compiled mode, use node with the .js file from dist/.
  let command: string;
  let args: string[];
  if (isTsxMode) {
    command = process.execPath;
    args = [resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), serverPath];
  } else {
    command = "node";
    args = [serverPath];
  }

  const config = {
    mcpServers: {
      "dev-swarm": {
        command,
        args,
        env: {
          DEV_SWARM_API_URL: `http://${host}:${port}`,
          DEV_SWARM_API_TOKEN: apiToken,
        },
      },
    },
  };

  const configPath = resolve(projectRoot, "mcp-config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  log.mcp.info({ configPath, apiHost: host, apiPort: port }, "MCP config written");
  return configPath;
}
