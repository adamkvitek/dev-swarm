import pLimit from "p-limit";
import { runCli } from "./cli-runner.js";
import type { Env } from "../config/env.js";
import type { Subtask } from "./cto.js";
import type { WorktreeManager, WorktreeInfo } from "../workspace/worktree-manager.js";

export interface WorkerResult {
  subtaskId: string;
  status: "completed" | "blocked";
  workDir: string;
  diff: string;
  files: string[];
  summary: string;
  blockerReason?: string;
}

const WORKER_SYSTEM_PROMPT = `You are a senior developer agent working on a real codebase.
Read relevant existing code before writing. Write clean production code.
Follow existing patterns and conventions you find in the codebase.
Run tests if a test runner exists (check package.json scripts, Makefile, etc.).
Include error handling and proper types.

When done, provide a brief summary of what you changed and why.`;

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

    console.log(`[WORKER ${subtask.id}] ${subtask.title} — starting in ${context.worktreeInfo.path}`);

    const prompt = promptParts.join("\n");

    const result = await runCli(this.claudeCli, [
      "--print", "--output-format", "text", "--dangerously-skip-permissions",
      "--allowedTools", "Bash,Edit,Read,Write,Glob,Grep",
      "-p", WORKER_SYSTEM_PROMPT,
    ], {
      timeoutMs: 1_800_000, // 30 min per worker
      stdin: prompt,
      cwd: context.worktreeInfo.path,
      signal: context.signal,
    });

    if (result.exitCode !== 0) {
      console.log(`[WORKER ${subtask.id}] Failed (exit ${result.exitCode})`);
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
    console.log(`[WORKER ${subtask.id}] Completed (${text.length} chars output)`);

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
    console.log(`[WORKERS] Dispatching ${subtasks.length} workers (max ${maxConcurrent} concurrent)`);

    // Create all worktrees sequentially (avoids git lock conflicts)
    const worktreeInfos: WorktreeInfo[] = [];
    for (const subtask of subtasks) {
      const info = await context.worktreeManager.create(
        context.repoPath,
        // Use a shared job ID derived from the first subtask's parent
        subtasks[0].id.split("-")[0] || subtasks[0].id,
        subtask.id,
      );
      worktreeInfos.push(info);
    }

    // Dispatch workers in parallel
    const limit = pLimit(maxConcurrent);
    let doneCount = 0;

    const results = await Promise.all(
      subtasks.map((subtask, i) =>
        limit(async () => {
          const result = await this.execute(subtask, {
            techStack: context.techStack,
            worktreeInfo: worktreeInfos[i],
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
    console.log(`[WORKERS] Done: ${completed}/${subtasks.length} completed`);
    return results;
  }
}

/**
 * Extract a summary from Claude's text output.
 * Takes the last paragraph or last few lines as a summary.
 */
function extractSummary(text: string): string {
  const lines = text.trim().split("\n");
  // Take up to the last 10 lines as summary
  const summaryLines = lines.slice(-10);
  return summaryLines.join("\n").slice(0, 2000);
}
