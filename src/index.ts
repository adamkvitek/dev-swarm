import { loadEnv } from "./config/env.js";
import { DiscordAdapter } from "./adapter/discord-adapter.js";
import { JobManager } from "./adapter/job-manager.js";
import { HttpApi } from "./adapter/http-api.js";
import { ResourceGuard } from "./adapter/resource-guard.js";
import { generateMcpConfig } from "./adapter/mcp-config.js";
import { WorkerAgent } from "./agents/worker.js";
import { ReviewerAgent } from "./agents/reviewer.js";
import { CouncilReviewer } from "./agents/council-reviewer.js";
import { WorktreeManager } from "./workspace/worktree-manager.js";
import { logger, log } from "./logger.js";

async function main(): Promise<void> {
  logger.info("Loading configuration...");
  const env = loadEnv();

  // 1. Worktree manager — isolated git worktrees for parallel workers
  const worktreeManager = new WorktreeManager(env.WORKSPACE_DIR);
  await worktreeManager.initialize();

  // 2. Agents + Job manager — owns worker/reviewer lifecycle
  const workerAgent = new WorkerAgent(env);
  const reviewerAgent = new ReviewerAgent(env);
  const councilReviewer = new CouncilReviewer(env);
  const jobManager = new JobManager(env, workerAgent, reviewerAgent, worktreeManager, councilReviewer);

  // 3. Resource guard — memory + worker capacity checks
  const resources = new ResourceGuard(
    env.MEMORY_CEILING_PCT,
    env.MAX_CONCURRENT_WORKERS,
    () => jobManager.getActiveWorkerCount(),
  );

  // 4. HTTP API — bridge between MCP server and adapter
  const httpApi = new HttpApi(jobManager, resources);
  await httpApi.start(env.MCP_API_HOST, env.MCP_API_PORT);

  // 5. Generate MCP config — tells Claude CLI how to spawn the MCP server
  const mcpConfigPath = await generateMcpConfig(env.MCP_API_HOST, env.MCP_API_PORT, httpApi.token);

  // 6. Discord adapter — bridges Discord <> Claude CLI
  const adapter = new DiscordAdapter(env, jobManager, resources);
  adapter.setMcpConfigPath(mcpConfigPath);

  // 7. Wire job completion notifications -> adapter -> Claude -> Discord
  jobManager.setOnJobComplete((job) => adapter.handleJobCompletion(job));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // Prevent double-shutdown from rapid Ctrl+C
    shuttingDown = true;

    log.shutdown.info({ signal }, "Graceful shutdown starting...");

    // 1. Stop accepting new messages
    await adapter.stop();
    log.shutdown.info("Discord adapter stopped");

    // 2. Cancel running jobs (sends SIGTERM to workers)
    jobManager.cancelAllJobs();
    log.shutdown.info("Running jobs cancelled");

    // 3. Stop HTTP API (no more MCP tool calls)
    await httpApi.stop();
    log.shutdown.info("HTTP API stopped");

    // 4. Clean up worktrees (with retry — may take a moment)
    await worktreeManager.removeAll();
    log.shutdown.info("Worktrees cleaned up");

    // 5. Final cleanup
    jobManager.destroy();
    log.shutdown.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await adapter.start();
  logger.info("Dev Swarm is running. Claude is the bot with MCP tools — waiting for @mentions...");
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
