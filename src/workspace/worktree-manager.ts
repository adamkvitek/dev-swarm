import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runCli } from "../agents/cli-runner.js";
import { log } from "../logger.js";
import {
  validateChangedFiles,
  getWorktreeChangedFiles,
  isSelfRepo,
  type DiffValidation,
} from "./control-plane.js";

export interface WorktreeInfo {
  path: string;       // absolute path to worktree dir
  branch: string;     // e.g. "worker/abc12345/1"
  repoPath: string;   // source repo
  jobId: string;
  subtaskId: string;
  isSelfRepo: boolean; // true if targeting the bot's own codebase
}

export interface MergeResult {
  featureBranch: string;
  validation: DiffValidation;
  merged: boolean; // false if blocked by control plane validation
}

/**
 * Manages git worktree lifecycle for parallel worker isolation.
 *
 * Each worker gets its own worktree so parallel workers can't conflict.
 * Worktree creation is serialized via an async queue to prevent git
 * lock file conflicts when creating multiple worktrees simultaneously.
 */
export class WorktreeManager {
  private workspaceDir: string;
  private worktrees = new Map<string, WorktreeInfo>();
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceDir: string) {
    // Resolve ~ at construction time
    this.workspaceDir = workspaceDir.startsWith("~")
      ? workspaceDir.replace("~", homedir())
      : workspaceDir;
    this.workspaceDir = resolve(this.workspaceDir);
  }

  async initialize(): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true });
    await this.cleanupStaleWorktrees();
    log.worktree.info({ path: this.workspaceDir }, "Workspace initialized");
  }

  /**
   * Scan workspace for stale worker-* directories left by previous crashed runs.
   * Cleans up git worktree bookkeeping and removes leftover directories.
   */
  private async cleanupStaleWorktrees(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.workspaceDir);
    } catch {
      return; // Directory doesn't exist or isn't readable — nothing to clean
    }

    const stale = entries.filter((name) => name.startsWith("worker-"));
    if (stale.length === 0) return;

    log.worktree.info({ count: stale.length }, "Found stale worktree directories from previous run, cleaning up");

    for (const dirName of stale) {
      const dirPath = resolve(this.workspaceDir, dirName);

      // Try to clean up git's worktree bookkeeping first
      try {
        await runCli("git", ["worktree", "remove", dirPath, "--force"], { timeoutMs: 15_000 });
      } catch {
        // git worktree remove may fail if the parent repo is gone — that's fine
      }

      // Remove the directory if it still exists
      try {
        await rm(dirPath, { recursive: true, force: true });
      } catch {
        log.worktree.warn({ path: dirPath }, "Failed to remove stale worktree directory");
      }

      log.worktree.info({ path: dirPath }, "Cleaned up stale worktree");
    }
  }

  /**
   * Create a worktree for a specific subtask. Serialized to avoid git lock conflicts.
   */
  async create(repoPath: string, jobId: string, subtaskId: string): Promise<WorktreeInfo> {
    // Serialize creation through the queue
    const result = await this.enqueue(() => this.doCreate(repoPath, jobId, subtaskId));
    return result;
  }

  /**
   * Remove a single worktree by job + subtask ID.
   */
  async remove(jobId: string, subtaskId: string): Promise<void> {
    const key = worktreeKey(jobId, subtaskId);
    const info = this.worktrees.get(key);
    if (!info) return;

    await this.doRemove(info);
    this.worktrees.delete(key);
  }

  /**
   * Remove all worktrees for a job.
   */
  async removeByJob(jobId: string): Promise<void> {
    const toRemove: WorktreeInfo[] = [];
    for (const [key, info] of this.worktrees) {
      if (info.jobId === jobId) {
        toRemove.push(info);
        this.worktrees.delete(key);
      }
    }
    await Promise.all(toRemove.map((info) => this.doRemove(info)));
  }

  /**
   * Merge all worker branches for a job into a feature branch.
   *
   * SAFETY: If the target repo is the bot's own codebase, validates the diff
   * against control plane protections BEFORE merging. If control plane files
   * are touched, the feature branch is still created (for human review) but
   * the merge is flagged as requiring manual approval.
   */
  async mergeToFeatureBranch(
    repoPath: string,
    jobId: string,
    taskSummary: string,
  ): Promise<MergeResult> {
    return this.enqueue(() => this.doMergeToFeatureBranch(repoPath, jobId, taskSummary));
  }

  private async doMergeToFeatureBranch(
    repoPath: string,
    jobId: string,
    taskSummary: string,
  ): Promise<MergeResult> {
    const shortId = jobId.slice(0, 8);
    const slug = taskSummary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40);
    const featureBranch = `feature/${slug || shortId}`;

    // Collect worker branches for this job
    const workerBranches: string[] = [];
    for (const info of this.worktrees.values()) {
      if (info.jobId === jobId) {
        workerBranches.push(info.branch);
      }
    }

    if (workerBranches.length === 0) {
      throw new Error(`No worktree branches found for job ${jobId}`);
    }

    // --- SAFETY GATE: Validate changed files before merging ---
    const selfRepo = await isSelfRepo(repoPath);
    let validation: DiffValidation = { safe: true, controlPlaneFiles: [], neverModifyFiles: [] };

    if (selfRepo) {
      log.worktree.info("SELF-REPO DETECTED — validating worker changes against control plane");

      // Collect all changed files across worker branches
      const allChangedFiles: string[] = [];
      for (const branch of workerBranches) {
        const files = await getWorktreeChangedFiles(repoPath, branch);
        allChangedFiles.push(...files);
      }
      const uniqueFiles = [...new Set(allChangedFiles)];

      validation = validateChangedFiles(uniqueFiles);

      if (!validation.safe) {
        log.worktree.warn({ reason: validation.reason }, "CONTROL PLANE VIOLATION");
        // Still create the branch so a human can review, but DON'T merge
        // The branch exists with the worker commits for inspection
      }
    }

    // Get the current HEAD of the repo to branch from
    const headResult = await runCli("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      timeoutMs: 10_000,
    });
    if (headResult.exitCode !== 0) {
      throw new Error(`Failed to get HEAD: ${headResult.stderr}`);
    }
    const baseCommit = headResult.stdout.trim();

    // Create the feature branch from the current HEAD
    const createResult = await runCli(
      "git",
      ["-C", repoPath, "checkout", "-b", featureBranch, baseCommit],
      { timeoutMs: 10_000 },
    );
    if (createResult.exitCode !== 0) {
      throw new Error(`Failed to create branch ${featureBranch}: ${createResult.stderr}`);
    }

    // Merge each worker branch
    for (const branch of workerBranches) {
      const mergeResult = await runCli(
        "git",
        ["-C", repoPath, "merge", branch, "--no-edit", "-m", `Merge ${branch}`],
        { timeoutMs: 30_000 },
      );
      if (mergeResult.exitCode !== 0) {
        // Abort the failed merge and throw
        await runCli("git", ["-C", repoPath, "merge", "--abort"], { timeoutMs: 10_000 });
        throw new Error(`Merge conflict merging ${branch}: ${mergeResult.stderr}`);
      }
    }

    // Return to the original branch
    await runCli("git", ["-C", repoPath, "checkout", "-"], { timeoutMs: 10_000 });

    const merged = validation.safe;
    log.worktree.info(
      { featureBranch, branchCount: workerBranches.length, merged },
      merged ? "Merged branches into feature branch" : "Created feature branch (PENDING HUMAN REVIEW)",
    );

    return { featureBranch, validation, merged };
  }

  /**
   * Remove all worktrees (shutdown cleanup).
   */
  async removeAll(): Promise<void> {
    const all = Array.from(this.worktrees.values());
    this.worktrees.clear();
    await Promise.all(all.map((info) => this.doRemove(info)));
    log.worktree.info({ count: all.length }, "Cleaned up worktrees");
  }

  /**
   * Get all worktree infos for a job.
   */
  getByJob(jobId: string): WorktreeInfo[] {
    const result: WorktreeInfo[] = [];
    for (const info of this.worktrees.values()) {
      if (info.jobId === jobId) {
        result.push(info);
      }
    }
    return result;
  }

  // --- Internals ---

  private async doCreate(
    repoPath: string,
    jobId: string,
    subtaskId: string,
  ): Promise<WorktreeInfo> {
    const shortId = sanitizeBranchSegment(jobId.slice(0, 8));
    const safeSubtaskId = sanitizeBranchSegment(subtaskId);
    const dirName = `worker-${shortId}-${safeSubtaskId}`;
    const worktreePath = resolve(this.workspaceDir, dirName);
    const branch = `worker/${shortId}/${safeSubtaskId}`;

    const result = await runCli(
      "git",
      ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath],
      { timeoutMs: 30_000 },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create worktree at ${worktreePath}: ${result.stderr}`,
      );
    }

    const selfRepo = await isSelfRepo(repoPath);
    if (selfRepo) {
      log.worktree.warn({ subtaskId }, "SELF-REPO: Worker targeting bot's own codebase");
    }

    const info: WorktreeInfo = {
      path: worktreePath,
      branch,
      repoPath,
      jobId,
      subtaskId,
      isSelfRepo: selfRepo,
    };

    this.worktrees.set(worktreeKey(jobId, subtaskId), info);
    log.worktree.info({ path: worktreePath, branch }, "Created worktree");
    return info;
  }

  private async doRemove(info: WorktreeInfo): Promise<void> {
    await retryWithBackoff(
      () => this.doRemoveOnce(info),
      `worktree ${info.path}`,
    );
  }

  private async doRemoveOnce(info: WorktreeInfo): Promise<void> {
    // Remove the worktree
    const removeResult = await runCli(
      "git",
      ["-C", info.repoPath, "worktree", "remove", info.path, "--force"],
      { timeoutMs: 15_000 },
    );
    if (removeResult.exitCode !== 0) {
      // Worktree dir might already be gone — try rm as fallback
      log.worktree.warn({ path: info.path, stderr: removeResult.stderr }, "git worktree remove failed, cleaning up manually");
      await rm(info.path, { recursive: true, force: true });
    }

    // Delete the branch
    await runCli(
      "git",
      ["-C", info.repoPath, "branch", "-D", info.branch],
      { timeoutMs: 10_000 },
    );
    log.worktree.info({ path: info.path, branch: info.branch }, "Removed worktree");
  }

  /**
   * Enqueue an async operation to serialize worktree creation.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let resolveCurrent: () => void;
    this.queue = new Promise<void>((r) => { resolveCurrent = r; });

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolveCurrent!();
      }
    });
  }
}

function worktreeKey(jobId: string, subtaskId: string): string {
  return `${jobId}:${subtaskId}`;
}

/**
 * Sanitize a string for safe use as a git branch name segment.
 * Strips anything that isn't alphanumeric, hyphens, underscores, or dots.
 */
function sanitizeBranchSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9\-_.]/g, "").slice(0, 50) || "unknown";
}

const RETRY_DELAYS_MS = [10_000, 30_000, 120_000]; // 10s, 30s, 2min

/**
 * Retry an async operation with exponential backoff.
 * Used for worktree cleanup — disk busy / git lock failures are transient.
 */
async function retryWithBackoff(fn: () => Promise<void>, label: string): Promise<void> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (attempt === RETRY_DELAYS_MS.length) {
        log.worktree.error({ err, label, attempts: attempt + 1 }, "Cleanup failed after retries");
        return; // Give up — don't crash the process over cleanup
      }
      const delay = RETRY_DELAYS_MS[attempt];
      log.worktree.warn({ label, attempt: attempt + 1, retryInSeconds: delay / 1000 }, "Cleanup attempt failed, retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
