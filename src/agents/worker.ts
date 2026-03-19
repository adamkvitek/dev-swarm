import pLimit from "p-limit";
import { runCli } from "./cli-runner.js";
import { WORKER_SYSTEM_PROMPT, extractSummary } from "./shared.js";
import { log } from "../logger.js";
import type { Env } from "../config/env.js";
import type { Subtask } from "./cto.js";
import type { WorktreeManager, WorktreeInfo } from "../workspace/worktree-manager.js";
import { SELF_REPO_WORKER_ADDENDUM } from "../workspace/control-plane.js";
import { buildWorkerStandards } from "./standards-loader.js";

export interface WorkerResult {
  subtaskId: string;
  status: "completed" | "blocked";
  workDir: string;
  diff: string;
  files: string[];
  summary: string;
  blockerReason?: string;
}

export class WorkerAgent {
  private claudeCli: string;

  constructor(private env: Env) {
    this.claudeCli = env.CLAUDE_CLI;
  }

  async execute(
    subtask: Subtask,
    context: {
      techStack: string[];
      worktreeInfo: WorktreeInfo;
      previousFeedback?: string;
      otherWorkerOutputs?: Map<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<WorkerResult> {
    const promptParts: string[] = [
      `## Subtask: ${subtask.title}`,
      subtask.description,
      `\n## Tech Stack: ${context.techStack.join(", ")}`,
    ];

    if (context.previousFeedback) {
      promptParts.push(
        `\n## Reviewer Feedback (fix these):\n${context.previousFeedback}`
      );
    }

    log.worker.info({ subtaskId: subtask.id, title: subtask.title, workDir: context.worktreeInfo.path }, "Starting worker");

    const prompt = promptParts.join("\n");

    // Build system prompt with code standards + optional self-repo guardrails
    const standards = await buildWorkerStandards(context.techStack, context.worktreeInfo.repoPath);
    let systemPrompt = WORKER_SYSTEM_PROMPT;
    if (standards) systemPrompt += "\n\n" + standards;
    if (context.worktreeInfo.isSelfRepo) systemPrompt += "\n" + SELF_REPO_WORKER_ADDENDUM;

    if (context.worktreeInfo.isSelfRepo) {
      log.worker.warn({ subtaskId: subtask.id }, "SELF-REPO MODE — control plane restrictions active");
    }

    const result = await runCli(this.claudeCli, [
      "--print", "--output-format", "text", "--dangerously-skip-permissions",
      "--allowedTools", "Bash,Edit,Read,Write,Glob,Grep",
      "-p", systemPrompt,
    ], {
      timeoutMs: 1_800_000, // 30 min per worker
      stdin: prompt,
      cwd: context.worktreeInfo.path,
      signal: context.signal,
    });

    if (result.exitCode !== 0) {
      log.worker.info({ subtaskId: subtask.id, exitCode: result.exitCode }, "Worker failed");
      return {
        subtaskId: subtask.id,
        status: "blocked",
        workDir: context.worktreeInfo.path,
        diff: "",
        files: [],
        summary: "",
        blockerReason: `CLI error (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
      };
    }

    const text = result.stdout.trim();
    log.worker.info({ subtaskId: subtask.id, outputChars: text.length }, "Worker completed");

    // Capture what changed in the worktree
    const diffResult = await runCli("git", ["diff", "HEAD"], {
      timeoutMs: 15_000,
      cwd: context.worktreeInfo.path,
    });
    const filesResult = await runCli("git", ["diff", "--name-only", "HEAD"], {
      timeoutMs: 15_000,
      cwd: context.worktreeInfo.path,
    });

    const diff = diffResult.exitCode === 0 ? diffResult.stdout : "";
    const files = filesResult.exitCode === 0
      ? filesResult.stdout.trim().split("\n").filter(Boolean)
      : [];

    // Check if there are untracked files too
    const untrackedResult = await runCli("git", ["ls-files", "--others", "--exclude-standard"], {
      timeoutMs: 15_000,
      cwd: context.worktreeInfo.path,
    });
    const untrackedFiles = untrackedResult.exitCode === 0
      ? untrackedResult.stdout.trim().split("\n").filter(Boolean)
      : [];

    const allFiles = [...new Set([...files, ...untrackedFiles])];

    // Commit all changes in the worktree
    if (allFiles.length > 0) {
      await runCli("git", ["add", "-A"], {
        timeoutMs: 15_000,
        cwd: context.worktreeInfo.path,
      });

      // Get the full diff after staging (for the result)
      const stagedDiff = await runCli("git", ["diff", "--staged"], {
        timeoutMs: 15_000,
        cwd: context.worktreeInfo.path,
      });

      await runCli("git", [
        "commit", "-m", `feat(worker): ${subtask.title}\n\nSubtask ${subtask.id} for job ${context.worktreeInfo.jobId}`,
      ], {
        timeoutMs: 15_000,
        cwd: context.worktreeInfo.path,
      });

      const finalDiff = stagedDiff.exitCode === 0 ? stagedDiff.stdout : diff;

      return {
        subtaskId: subtask.id,
        status: "completed",
        workDir: context.worktreeInfo.path,
        diff: finalDiff.slice(0, 50_000), // Cap diff size for sanity
        files: allFiles,
        summary: extractSummary(text),
      };
    }

    // No files changed — worker may have found nothing to do
    return {
      subtaskId: subtask.id,
      status: "completed",
      workDir: context.worktreeInfo.path,
      diff: "",
      files: [],
      summary: extractSummary(text) || "No files were modified.",
    };
  }

  async executeParallel(
    subtasks: Subtask[],
    context: {
      techStack: string[];
      repoPath: string;
      worktreeManager: WorktreeManager;
      previousFeedback?: string;
      signal?: AbortSignal;
    },
    onWorkerDone?: (result: WorkerResult, index: number, total: number) => void | Promise<void>
  ): Promise<WorkerResult[]> {
    const maxConcurrent = this.env.MAX_CONCURRENT_WORKERS;
    log.worker.info({ total: subtasks.length, maxConcurrent }, "Dispatching workers");

    // Create all worktrees sequentially (avoids git lock conflicts)
    // Use Map keyed by subtask ID — avoids fragile array index coupling
    const worktreeMap = new Map<string, WorktreeInfo>();
    const jobId = subtasks[0].id.split("-")[0] || subtasks[0].id;
    for (const subtask of subtasks) {
      const info = await context.worktreeManager.create(
        context.repoPath,
        jobId,
        subtask.id,
      );
      worktreeMap.set(subtask.id, info);
    }

    // Dispatch workers in parallel
    const limit = pLimit(maxConcurrent);
    let doneCount = 0;

    const results = await Promise.all(
      subtasks.map((subtask) =>
        limit(async () => {
          const worktreeInfo = worktreeMap.get(subtask.id)!;
          const result = await this.execute(subtask, {
            techStack: context.techStack,
            worktreeInfo,
            previousFeedback: context.previousFeedback,
            signal: context.signal,
          });
          doneCount++;
          if (onWorkerDone) {
            await onWorkerDone(result, doneCount, subtasks.length);
          }
          return result;
        })
      )
    );

    const completed = results.filter((r) => r.status === "completed").length;
    log.worker.info({ completed, total: subtasks.length }, "All workers done");
    return results;
  }
}

