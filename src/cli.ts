import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { loadEnv } from "./config/env.js";
import { JobManager } from "./adapter/job-manager.js";
import { HttpApi } from "./adapter/http-api.js";
import { ResourceGuard } from "./adapter/resource-guard.js";
import { generateMcpConfig } from "./adapter/mcp-config.js";
import { WorkerAgent } from "./agents/worker.js";
import { ReviewerAgent } from "./agents/reviewer.js";
import { CouncilReviewer } from "./agents/council-reviewer.js";
import { CouncilWorkerAgent } from "./agents/council-worker.js";
import { WorktreeManager } from "./workspace/worktree-manager.js";
import { ClaudeSession } from "./agents/claude-session.js";
import { logger, log } from "./logger.js";

/**
 * Terminal mode — run the dev swarm from your terminal.
 * No Discord, no company data exposure. Same pipeline, same tools.
 *
 * Usage: npm run cli
 */
async function main(): Promise<void> {
  logger.info("Starting dev-swarm in terminal mode...");
  const env = loadEnv();

  // Infrastructure (same as Discord mode)
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
  );

  const httpApi = new HttpApi(jobManager, resources);
  await httpApi.start(env.MCP_API_HOST, env.MCP_API_PORT);

  const mcpConfigPath = await generateMcpConfig(env.MCP_API_HOST, env.MCP_API_PORT, httpApi.token);

  // Load system prompt
  let systemPrompt: string;
  try {
    systemPrompt = await readFile(env.SYSTEM_PROMPT_PATH, "utf-8");
  } catch {
    systemPrompt = "You are Daskyleion, a CTO-level AI agent. Be concise, helpful, and technical.";
  }

  // Add resource status to system prompt
  systemPrompt += `\n\n## Current System Status\n${resources.statusLine()}`;

  // Create a single persistent session with MCP tools
  const session = new ClaudeSession(
    env.CLAUDE_CLI,
    ["--dangerously-skip-permissions"],
    mcpConfigPath,
    systemPrompt,
  );

  // Wire job completion notifications → print to terminal
  jobManager.setOnJobComplete(async (job) => {
    if (job.type === "workers") {
      const total = job.workerResults?.length ?? 0;
      const completed = job.workerResults?.filter((r) => r.status === "completed").length ?? 0;
      console.log(`\n[JOB DONE] Worker job ${job.id}: ${completed}/${total} completed`);
    } else if (job.type === "review") {
      const verdict = job.reviewResult?.verdict ?? "unknown";
      const avg = job.reviewResult?.scores.average.toFixed(1) ?? "?";
      console.log(`\n[JOB DONE] Review job ${job.id}: ${verdict} (score: ${avg})`);
    }
    if (job.status === "failed") {
      console.log(`[JOB FAILED] ${job.error}`);
    }

    // Send notification to Claude session so it can act on results
    const notification = job.type === "workers"
      ? `[SYSTEM] Worker job ${job.id} ${job.status}. Use get_job_result("${job.id}") for details.`
      : `[SYSTEM] Review job ${job.id} ${job.status}. Use get_job_result("${job.id}") for details.`;

    try {
      const result = await session.send(notification, { timeoutMs: env.CLAUDE_RESPONSE_TIMEOUT_MS });
      console.log(`\nDaskyleion: ${result.text}\n`);
      process.stdout.write("You: ");
    } catch (err) {
      log.adapter.error({ err }, "Failed to send job notification to session");
    }
  });

  // Interactive REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Dev Swarm — Terminal Mode");
  console.log(`  ${resources.statusLine()}`);
  console.log("  Type your request (multi-line: end with empty line).");
  console.log("  Ctrl+C to exit.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  /**
   * Read multi-line input. Collects lines until the user sends an empty line.
   * Single-line inputs are sent immediately (for quick prompts).
   */
  const readInput = (): Promise<string> => {
    return new Promise((resolve) => {
      const lines: string[] = [];
      let firstLine = true;

      const onLine = (line: string): void => {
        if (firstLine) {
          firstLine = false;
          // If this is the only line and there's a pause, treat as single-line
          lines.push(line);

          // Give a short window for more pasted lines to arrive
          const timer = setTimeout(() => {
            // No more lines came — check if input looks complete
            if (lines.length === 1 && lines[0].trim()) {
              rl.removeListener("line", onLine);
              resolve(lines.join("\n"));
            }
          }, 100);

          // If another line arrives quickly, cancel the single-line timer
          rl.once("line", (nextLine) => {
            clearTimeout(timer);
            rl.removeListener("line", onLine);

            // Continue collecting lines until empty line
            lines.push(nextLine);
            const collectMore = (l: string): void => {
              if (l.trim() === "") {
                rl.removeListener("line", collectMore);
                resolve(lines.join("\n"));
              } else {
                lines.push(l);
              }
            };
            rl.on("line", collectMore);
          });
          return;
        }
      };

      process.stdout.write("You: ");
      rl.once("line", onLine);
    });
  };

  const ask = async (): Promise<void> => {
    while (true) {
      const input = await readInput();
      const trimmed = input.trim();
      if (!trimmed) continue;

      try {
        const result = await session.send(trimmed, {
          timeoutMs: env.CLAUDE_RESPONSE_TIMEOUT_MS,
        });
        console.log(`\nDaskyleion: ${result.text}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\nError: ${msg}\n`);
        if (msg.includes("timed out")) {
          console.log("(Request timed out. Try breaking it into smaller tasks.)\n");
        }
      }
    }
  };

  void ask();

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("\nShutting down...");
    rl.close();
    jobManager.cancelAllJobs();
    await httpApi.stop();
    await worktreeManager.removeAll();
    jobManager.destroy();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
