import { runCli } from "./cli-runner.js";
import { WORKER_SYSTEM_PROMPT, extractSummary } from "./shared.js";
import { log } from "../logger.js";
import { buildWorkerStandards } from "./standards-loader.js";
import { SELF_REPO_WORKER_ADDENDUM } from "../workspace/control-plane.js";
import type { Env } from "../config/env.js";
import type { Subtask } from "./cto.js";
import type { WorktreeManager, WorktreeInfo } from "../workspace/worktree-manager.js";
import type { WorkerResult } from "./worker.js";

/**
 * Result from a single council worker (one model's implementation).
 */
export interface CouncilWorkerResult extends WorkerResult {
  model: string; // "claude" or "gemini"
}

/**
 * Result from the council for one subtask — multiple implementations + chosen best.
 */
export interface CouncilSubtaskResult {
  subtaskId: string;
  implementations: CouncilWorkerResult[];
  bestModel: string;
  bestResult: WorkerResult;
  reasoning: string;
}

/**
 * Council Worker — fans out each subtask to multiple AI models.
 *
 * For each subtask:
 * 1. Claude, Codex, and Gemini each implement it independently in separate worktrees
 * 2. A judge compares all implementations and picks the best one
 * 3. Returns the winning implementation for each subtask
 *
 * This is opt-in for critical tasks — costs 3x worker resources.
 */
export class CouncilWorkerAgent {
  private claudeCli: string;
  private codexCli: string;
  private geminiCli: string;

  constructor(private env: Env) {
    this.claudeCli = env.CLAUDE_CLI;
    this.codexCli = env.CODEX_CLI;
    this.geminiCli = env.GEMINI_CLI;
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
    onSubtaskDone?: (result: CouncilSubtaskResult, index: number, total: number) => void | Promise<void>,
  ): Promise<WorkerResult[]> {
    log.worker.info(
      { subtasks: subtasks.length, mode: "council" },
      "Council mode: dispatching subtasks to Claude + Gemini",
    );

    const standards = await buildWorkerStandards(context.techStack, context.repoPath);
    let doneCount = 0;
    const results: WorkerResult[] = [];

    // Process subtasks sequentially (each subtask spawns 2 parallel workers)
    for (const subtask of subtasks) {
      const councilResult = await this.executeCouncilSubtask(
        subtask, context, standards,
      );

      results.push(councilResult.bestResult);
      doneCount++;

      if (onSubtaskDone) {
        await onSubtaskDone(councilResult, doneCount, subtasks.length);
      }
    }

    const completed = results.filter((r) => r.status === "completed").length;
    log.worker.info({ completed, total: subtasks.length, mode: "council" }, "Council workers done");
    return results;
  }

  private async executeCouncilSubtask(
    subtask: Subtask,
    context: {
      techStack: string[];
      repoPath: string;
      worktreeManager: WorktreeManager;
      previousFeedback?: string;
      signal?: AbortSignal;
    },
    standards: string,
  ): Promise<CouncilSubtaskResult> {
    // Create worktrees for all three models
    const jobId = subtask.id.split("-")[0] || subtask.id;
    const claudeWorktree = await context.worktreeManager.create(
      context.repoPath, jobId, `${subtask.id}-claude`,
    );
    const codexWorktree = await context.worktreeManager.create(
      context.repoPath, jobId, `${subtask.id}-codex`,
    );
    const geminiWorktree = await context.worktreeManager.create(
      context.repoPath, jobId, `${subtask.id}-gemini`,
    );

    const prompt = this.buildPrompt(subtask, context.techStack, context.previousFeedback);
    let systemPrompt = WORKER_SYSTEM_PROMPT;
    if (standards) systemPrompt += "\n\n" + standards;
    if (claudeWorktree.isSelfRepo) systemPrompt += "\n" + SELF_REPO_WORKER_ADDENDUM;

    log.worker.info(
      { subtaskId: subtask.id, models: ["claude", "codex", "gemini"] },
      "Council: fan-out to all models",
    );

    // Fan out to all three models in parallel
    const [claudeResult, codexResult, geminiResult] = await Promise.allSettled([
      this.runClaude(subtask, claudeWorktree, prompt, systemPrompt, context.signal),
      this.runCodex(subtask, codexWorktree, prompt, systemPrompt, context.signal),
      this.runGemini(subtask, geminiWorktree, prompt, systemPrompt, context.signal),
    ]);

    const implementations: CouncilWorkerResult[] = [];
    const modelResults = [
      { result: claudeResult, model: "claude" },
      { result: codexResult, model: "codex" },
      { result: geminiResult, model: "gemini" },
    ];

    for (const { result, model } of modelResults) {
      if (result.status === "fulfilled") {
        implementations.push({ ...result.value, model });
      } else {
        log.worker.warn({ subtaskId: subtask.id, model, error: String(result.reason) }, "Council worker failed");
      }
    }

    // Pick the best implementation
    if (implementations.length === 0) {
      return {
        subtaskId: subtask.id,
        implementations: [],
        bestModel: "none",
        bestResult: {
          subtaskId: subtask.id,
          status: "blocked",
          workDir: claudeWorktree.path,
          diff: "",
          files: [],
          summary: "",
          blockerReason: "All council workers failed",
        },
        reasoning: "All models failed to produce an implementation",
      };
    }

    if (implementations.length === 1) {
      const only = implementations[0];
      return {
        subtaskId: subtask.id,
        implementations,
        bestModel: only.model,
        bestResult: only,
        reasoning: `Only ${only.model} succeeded — using its implementation`,
      };
    }

    // Both succeeded — pick the best one
    const best = await this.pickBest(subtask, implementations, context.signal);
    return best;
  }

  private async runClaude(
    subtask: Subtask,
    worktree: WorktreeInfo,
    prompt: string,
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    const result = await runCli(this.claudeCli, [
      "--print", "--output-format", "text", "--dangerously-skip-permissions",
      "--allowedTools", "Bash,Edit,Read,Write,Glob,Grep",
      "-p", systemPrompt,
    ], {
      timeoutMs: 1_800_000,
      stdin: prompt,
      cwd: worktree.path,
      signal,
    });

    return this.captureResult(subtask, worktree, result.exitCode, result.stdout, result.stderr);
  }

  private async runCodex(
    subtask: Subtask,
    worktree: WorktreeInfo,
    prompt: string,
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    // Codex uses "exec --full-auto" for agentic mode
    const fullPrompt = `${systemPrompt}\n\n${prompt}`;
    const result = await runCli(this.codexCli, [
      "exec", "--full-auto", "-C", worktree.path, "--json",
    ], {
      timeoutMs: 1_800_000,
      stdin: fullPrompt,
      signal,
    });

    return this.captureResult(subtask, worktree, result.exitCode, result.stdout, result.stderr);
  }

  private async runGemini(
    subtask: Subtask,
    worktree: WorktreeInfo,
    prompt: string,
    _systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    // Gemini CLI uses -p for prompt, --yolo for auto-approve
    const result = await runCli(this.geminiCli, [
      "-p", `${_systemPrompt}\n\n${prompt}`,
      "--output-format", "text",
      "--yolo",
    ], {
      timeoutMs: 1_800_000,
      cwd: worktree.path,
      signal,
    });

    return this.captureResult(subtask, worktree, result.exitCode, result.stdout, result.stderr);
  }

  private async captureResult(
    subtask: Subtask,
    worktree: WorktreeInfo,
    exitCode: number,
    stdout: string,
    stderr: string,
  ): Promise<WorkerResult> {
    if (exitCode !== 0) {
      return {
        subtaskId: subtask.id,
        status: "blocked",
        workDir: worktree.path,
        diff: "",
        files: [],
        summary: "",
        blockerReason: `CLI error (exit ${exitCode}): ${stderr.slice(0, 200)}`,
      };
    }

    // Capture changes
    const diffResult = await runCli("git", ["diff", "HEAD"], { timeoutMs: 15_000, cwd: worktree.path });
    const filesResult = await runCli("git", ["diff", "--name-only", "HEAD"], { timeoutMs: 15_000, cwd: worktree.path });
    const untrackedResult = await runCli("git", ["ls-files", "--others", "--exclude-standard"], { timeoutMs: 15_000, cwd: worktree.path });

    const files = filesResult.exitCode === 0 ? filesResult.stdout.trim().split("\n").filter(Boolean) : [];
    const untracked = untrackedResult.exitCode === 0 ? untrackedResult.stdout.trim().split("\n").filter(Boolean) : [];
    const allFiles = [...new Set([...files, ...untracked])];

    if (allFiles.length > 0) {
      await runCli("git", ["add", "-A"], { timeoutMs: 15_000, cwd: worktree.path });
      const stagedDiff = await runCli("git", ["diff", "--staged"], { timeoutMs: 15_000, cwd: worktree.path });
      await runCli("git", [
        "commit", "-m", `feat(council): ${subtask.title}\n\nCouncil worker for ${subtask.id}`,
      ], { timeoutMs: 15_000, cwd: worktree.path });

      return {
        subtaskId: subtask.id,
        status: "completed",
        workDir: worktree.path,
        diff: (stagedDiff.exitCode === 0 ? stagedDiff.stdout : diffResult.stdout).slice(0, 50_000),
        files: allFiles,
        summary: extractSummary(stdout),
      };
    }

    return {
      subtaskId: subtask.id,
      status: "completed",
      workDir: worktree.path,
      diff: "",
      files: [],
      summary: extractSummary(stdout) || "No files were modified.",
    };
  }

  /**
   * Compare implementations and pick the best one.
   * Uses Claude as the judge (fast, good at analysis).
   * Handles 2 or 3 implementations (A/B/C).
   */
  private async pickBest(
    subtask: Subtask,
    implementations: CouncilWorkerResult[],
    signal?: AbortSignal,
  ): Promise<CouncilSubtaskResult> {
    const labels = implementations.map((_, i) => String.fromCharCode(65 + i)); // A, B, C...
    const comparison = implementations.map((impl, i) => {
      const label = `Implementation ${labels[i]}`;
      return `### ${label}\nModel: [anonymized]\nFiles changed: ${impl.files.join(", ")}\nSummary: ${impl.summary}\n\nDiff:\n\`\`\`\n${impl.diff.slice(0, 8_000)}\n\`\`\``;
    }).join("\n\n---\n\n");

    const judgePrompt = [
      `Task: ${subtask.title}`,
      subtask.description,
      "",
      `${implementations.length} different AI models implemented this task independently. Compare them:`,
      "",
      comparison,
      "",
      "Which implementation is better? Consider: correctness, code quality, completeness, test coverage.",
      `Respond with ONLY: '${labels.join("' or '")}' followed by a brief reason.`,
    ].join("\n");

    const result = await runCli(this.claudeCli, [
      "--print", "--output-format", "text", "--dangerously-skip-permissions",
    ], { timeoutMs: 300_000, stdin: judgePrompt, signal });

    let bestIdx = 0; // default to first (Claude)
    let reasoning = "Default to first implementation";

    if (result.exitCode === 0) {
      const text = result.stdout.trim();
      const firstChar = text.charAt(0).toUpperCase();
      const chosenIdx = labels.indexOf(firstChar);
      if (chosenIdx >= 0) {
        bestIdx = chosenIdx;
      }
      reasoning = text.slice(0, 500);
    }

    const best = implementations[bestIdx];
    log.worker.info(
      { subtaskId: subtask.id, bestModel: best.model, reason: reasoning.slice(0, 100) },
      "Council: best implementation selected",
    );

    return {
      subtaskId: subtask.id,
      implementations,
      bestModel: best.model,
      bestResult: best,
      reasoning,
    };
  }

  private buildPrompt(subtask: Subtask, techStack: string[], previousFeedback?: string): string {
    const parts = [
      `## Subtask: ${subtask.title}`,
      subtask.description,
      `\n## Tech Stack: ${techStack.join(", ")}`,
    ];
    if (previousFeedback) {
      parts.push(`\n## Reviewer Feedback (fix these):\n${previousFeedback}`);
    }
    return parts.join("\n");
  }
}

