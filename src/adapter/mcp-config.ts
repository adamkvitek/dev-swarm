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
  // Resolve the compiled server entry point relative to this file's dist location
  // Both this file and server.ts compile to dist/, so:
  // dist/adapter/mcp-config.js → dist/mcp/server.js
  const serverPath = resolve(__dirname, "..", "mcp", "server.js");

  const config = {
    mcpServers: {
      "dev-swarm": {
        command: "node",
        args: [serverPath],
        env: {
          DEV_SWARM_API_URL: `http://${host}:${port}`,
          DEV_SWARM_API_TOKEN: apiToken,
        },
      },
    },
  };

  const configPath = resolve(__dirname, "..", "..", "mcp-config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  log.mcp.info({ configPath, apiHost: host, apiPort: port }, "MCP config written");
  return configPath;
}
