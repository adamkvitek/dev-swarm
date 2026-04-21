import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { JobManager } from "./adapter/job-manager.js";
import { HttpApi } from "./adapter/http-api.js";
import { ResourceGuard } from "./adapter/resource-guard.js";
import { generateMcpConfig, cleanupMcpConfig } from "./adapter/mcp-config.js";
import { WorkerAgent } from "./agents/worker.js";
import { ReviewerAgent } from "./agents/reviewer.js";
import { CouncilReviewer } from "./agents/council-reviewer.js";
import { CouncilWorkerAgent } from "./agents/council-worker.js";
import { WorktreeManager } from "./workspace/worktree-manager.js";
import { logger, log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let shutdownFn: ((signal: string) => Promise<void>) | null = null;

process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "Unhandled rejection");
  if (shutdownFn) { void shutdownFn("unhandledRejection"); return; }
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  if (shutdownFn) { void shutdownFn("uncaughtException"); return; }
  process.exit(1);
});

/**
 * Read the existing API token from mcp-config.json if it exists.
 * This ensures that restarting serve.ts doesn't invalidate tokens
 * held by already-running MCP server processes.
 */
function readExistingToken(): string | undefined {
  try {
    const configPath = resolve(__dirname, "..", "mcp-config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const token = config?.mcpServers?.["dev-swarm"]?.env?.DEV_SWARM_API_TOKEN;
    if (typeof token === "string" && token.length > 0) {
      log.httpApi.info("Reusing existing API token from mcp-config.json");
      return token;
    }
  } catch {
    // No existing config — a fresh token will be generated
  }
  return undefined;
}

/**
 * Headless server mode — starts the HTTP API and MCP config only.
 * Use with Claude Code directly:
 *
 *   Terminal 1: npm run serve
 *   Terminal 2: claude --mcp-config mcp-config.json --append-system-prompt "$(cat prompts/system.md)"
 *
 * This gives you the REAL Claude experience (colors, streaming, interactive)
 * with full access to the dev-swarm MCP tools.
 */
async function main(): Promise<void> {
  logger.info("Starting dev-swarm server (headless)...");
  const env = loadEnv();

  const worktreeManager = new WorktreeManager(env.WORKSPACE_DIR);
  await worktreeManager.initialize();

  const workerAgent = new WorkerAgent(env);
  const reviewerAgent = new ReviewerAgent(env);
  const councilReviewer = new CouncilReviewer(env);
  const councilWorker = new CouncilWorkerAgent(env);
  const jobManager = new JobManager(env, workerAgent, reviewerAgent, worktreeManager, councilReviewer, councilWorker);

  const resources = new ResourceGuard(
    env.MEMORY_CEILING_PCT,
    env.MAX_CONCURRENT_WORKERS,
    () => jobManager.getActiveWorkerCount(),
    env.CPU_CEILING_PCT,
  );

  const existingToken = readExistingToken();
  const httpApi = new HttpApi(jobManager, resources, existingToken);

  // Generate MCP config BEFORE starting the HTTP API. dev-swarm.ts launches
  // Claude immediately after the health check passes, so the config must be
  // on disk before /health can respond — otherwise Claude reads a stale file.
  const mcpConfigPath = await generateMcpConfig(env.MCP_API_HOST, env.MCP_API_PORT, httpApi.token);

  await httpApi.start(env.MCP_API_HOST, env.MCP_API_PORT);

  // Wire job completion — log to console since there's no adapter
  jobManager.setOnJobComplete((job) => {
    if (job.type === "workers") {
      const total = job.workerResults?.length ?? 0;
      const completed = job.workerResults?.filter((r) => r.status === "completed").length ?? 0;
      log.jobMgr.info({ jobId: job.id, completed, total }, "Worker job completed");
    } else if (job.type === "review") {
      const verdict = job.reviewResult?.verdict ?? "unknown";
      log.jobMgr.info({ jobId: job.id, verdict }, "Review job completed");
    }
  });

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Dev Swarm server running");
  console.log(`  ${resources.statusLine()}`);
  console.log(`  MCP config: ${mcpConfigPath}`);
  console.log("");
  console.log("  Now open another terminal and run:");
  console.log("");
  console.log(`  claude --mcp-config ${mcpConfigPath} \\`);
  console.log(`    --append-system-prompt "$(cat prompts/system.md)"`);
  console.log("");
  console.log("  That gives you the real Claude with swarm tools.");
  console.log("  Ctrl+C to stop the server.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const shutdown = async (signal: string): Promise<void> => {
    log.shutdown.info({ signal }, "Shutting down server...");
    jobManager.cancelAllJobs();
    await httpApi.stop();
    await worktreeManager.removeAll();
    await cleanupMcpConfig();
    jobManager.destroy();
    process.exit(0);
  };

  shutdownFn = shutdown;
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP")); // terminal closed
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
