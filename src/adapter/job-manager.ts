import { randomUUID } from "node:crypto";
import type { WorkerAgent, WorkerResult } from "../agents/worker.js";
import type { ReviewerAgent, ReviewResult } from "../agents/reviewer.js";
import type { Subtask } from "../agents/cto.js";
import type { Env } from "../config/env.js";
import type { WorktreeManager, MergeResult } from "../workspace/worktree-manager.js";

export type JobType = "workers" | "review";
export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  channelId: string;
  type: JobType;
  status: JobStatus;
  createdAt: number;
  completedAt?: number;
  subtasks?: Subtask[];
  workerResults?: WorkerResult[];
  reviewResult?: ReviewResult;
  repoPath?: string;
  featureBranch?: string;
  error?: string;
}

export type JobCompleteCallback = (job: Job) => void | Promise<void>;

const JOB_EVICTION_MS = 60 * 60 * 1000; // 1 hour
const MAX_STORED_JOBS = 1000;

/**
 * Manages long-lived worker and review jobs.
 *
 * The adapter process is persistent; Claude CLI (and MCP) are ephemeral.
 * JobManager holds state across Claude invocations — it owns the lifecycle
 * of workers and reviewers, and fires a callback when jobs finish so the
 * adapter can notify Claude.
 */
export class JobManager {
  private jobs = new Map<string, Job>();
  private abortControllers = new Map<string, AbortController>();
  private evictionTimer: ReturnType<typeof setInterval>;
  private workerAgent: WorkerAgent;
  private reviewerAgent: ReviewerAgent;
  private worktreeManager: WorktreeManager;
  private env: Env;
  private onJobComplete: JobCompleteCallback | null = null;

  constructor(
    env: Env,
    workerAgent: WorkerAgent,
    reviewerAgent: ReviewerAgent,
    worktreeManager: WorktreeManager,
  ) {
    this.env = env;
    this.workerAgent = workerAgent;
    this.reviewerAgent = reviewerAgent;
    this.worktreeManager = worktreeManager;

    // Evict completed/failed jobs older than 1 hour
    this.evictionTimer = setInterval(() => {
      try {
        this.evictOldJobs();
      } catch (err) {
        console.error("[job-manager] Eviction timer error:", err);
      }
    }, 5 * 60 * 1000);
    this.evictionTimer.unref();
  }

  setOnJobComplete(cb: JobCompleteCallback): void {
    this.onJobComplete = cb;
  }

  getActiveWorkerCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.type === "workers" && job.status === "running") {
        count += job.subtasks?.length ?? 0;
      }
    }
    return count;
  }

  createWorkerJob(
    channelId: string,
    subtasks: Subtask[],
    techStack: string[],
    repoPath: string,
    previousFeedback?: string,
  ): Job | { error: string } {
    // Resource check: active workers + new batch must not exceed limit
    const activeCount = this.getActiveWorkerCount();
    if (activeCount + subtasks.length > this.env.MAX_CONCURRENT_WORKERS) {
      return {
        error: `Cannot spawn ${subtasks.length} workers: ${activeCount} already active, max ${this.env.MAX_CONCURRENT_WORKERS}. Wait for current jobs to finish.`,
      };
    }

    const job: Job = {
      id: randomUUID(),
      channelId,
      type: "workers",
      status: "running",
      createdAt: Date.now(),
      subtasks,
      repoPath,
    };
    this.storeJob(job);

    // Fire and forget — runs in background, calls onJobComplete when done
    void this.runJob(
      job,
      () => this.workerAgent.executeParallel(job.subtasks!, {
        techStack,
        repoPath: job.repoPath!,
        worktreeManager: this.worktreeManager,
        previousFeedback,
        signal: this.abortControllers.get(job.id)!.signal,
      }),
      (results) => { job.workerResults = results; },
      `Worker job ${job.id} completed (${subtasks.length} subtasks)`,
    );

    return job;
  }

  createReviewJob(
    channelId: string,
    workerJobId: string,
    taskDescription: string,
    iteration: number,
  ): Job | { error: string } {
    const workerJob = this.jobs.get(workerJobId);
    if (!workerJob) {
      return { error: `Worker job ${workerJobId} not found` };
    }
    if (workerJob.status !== "completed" || !workerJob.workerResults) {
      return { error: `Worker job ${workerJobId} is not completed or has no results` };
    }

    const job: Job = {
      id: randomUUID(),
      channelId,
      type: "review",
      status: "running",
      createdAt: Date.now(),
      repoPath: workerJob.repoPath,
    };
    this.storeJob(job);

    void this.runJob(
      job,
      () => this.reviewerAgent.review(
        workerJob.workerResults!,
        taskDescription,
        iteration,
        this.abortControllers.get(job.id)?.signal,
      ),
      (result) => { job.reviewResult = result; },
      `Review job ${job.id} completed (verdict: ${workerJob.workerResults ? "pending" : "unknown"})`,
    );

    return job;
  }

  /**
   * Merge worker branches for a job into a feature branch.
   * Returns the merge result including safety validation status.
   */
  async mergeJob(jobId: string, taskSummary: string): Promise<MergeResult> {
    const job = this.jobs.get(jobId);
    if (!job?.repoPath) {
      throw new Error(`Job ${jobId} not found or has no repo path`);
    }

    const workerJob = job.type === "workers" ? job : this.findWorkerJobForReview(jobId);
    if (!workerJob?.repoPath) {
      throw new Error(`No worker job with repo path found for ${jobId}`);
    }

    const mergeResult = await this.worktreeManager.mergeToFeatureBranch(
      workerJob.repoPath,
      workerJob.id,
      taskSummary,
    );

    job.featureBranch = mergeResult.featureBranch;
    return mergeResult;
  }

  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return false;

    const ac = this.abortControllers.get(jobId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(jobId);
    }

    job.status = "cancelled";
    job.completedAt = Date.now();

    void this.worktreeManager.removeByJob(jobId).catch((err) => {
      console.error(`[job-manager] Worktree cleanup failed for cancelled job ${jobId}:`, err);
    });

    return true;
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  getJobs(filters?: { channelId?: string; status?: JobStatus }): Job[] {
    let result = Array.from(this.jobs.values());
    if (filters?.channelId) {
      result = result.filter((j) => j.channelId === filters.channelId);
    }
    if (filters?.status) {
      result = result.filter((j) => j.status === filters.status);
    }
    return result;
  }

  cancelAllJobs(): void {
    for (const [jobId, ac] of this.abortControllers) {
      ac.abort();
      const job = this.jobs.get(jobId);
      if (job && job.status === "running") {
        job.status = "cancelled";
        job.completedAt = Date.now();
      }
    }
    this.abortControllers.clear();
  }

  destroy(): void {
    this.cancelAllJobs();
    clearInterval(this.evictionTimer);
    void this.worktreeManager.removeAll().catch((err) => {
      console.error("[job-manager] Worktree cleanup on destroy failed:", err);
    });
  }

  // --- Internal helpers ---

  /**
   * Store a job with hard cap enforcement.
   * Prevents unbounded Map growth by evicting oldest completed jobs when at capacity.
   */
  private storeJob(job: Job): void {
    if (this.jobs.size >= MAX_STORED_JOBS) {
      this.evictOldest();
    }

    this.jobs.set(job.id, job);

    const ac = new AbortController();
    this.abortControllers.set(job.id, ac);
  }

  /**
   * Generic job runner — eliminates duplication between worker and review jobs.
   *
   * Handles: abort check, execution, status transitions, error handling,
   * abort controller cleanup, and completion callback.
   */
  private async runJob<T>(
    job: Job,
    execute: () => Promise<T>,
    onSuccess: (result: T) => void,
    successLog: string,
  ): Promise<void> {
    const signal = this.abortControllers.get(job.id)?.signal;

    try {
      if (signal?.aborted) return;

      const result = await execute();

      if (signal?.aborted) return;

      onSuccess(result);
      job.status = "completed";
      job.completedAt = Date.now();

      console.log(`[job-manager] ${successLog}`);
    } catch (err) {
      if (signal?.aborted) return;

      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = Date.now();

      console.error(`[job-manager] Job ${job.id} failed:`, job.error);
    } finally {
      this.abortControllers.delete(job.id);
      if (this.onJobComplete && !signal?.aborted) {
        await Promise.resolve(this.onJobComplete(job)).catch((err) => {
          console.error(`[job-manager] onJobComplete callback error:`, err);
        });
      }
    }
  }

  private evictOldJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (
        job.completedAt &&
        job.status !== "running" &&
        now - job.completedAt > JOB_EVICTION_MS
      ) {
        void this.worktreeManager.removeByJob(id).catch((err) => {
          console.error(`[job-manager] Worktree cleanup on eviction failed for ${id}:`, err);
        });
        this.jobs.delete(id);
        console.log(`[job-manager] Evicted old job ${id} (${job.type}, ${job.status})`);
      }
    }
  }

  /**
   * Evict the oldest completed/failed jobs to stay under MAX_STORED_JOBS.
   */
  private evictOldest(): void {
    const completed = Array.from(this.jobs.entries())
      .filter(([, j]) => j.status !== "running")
      .sort(([, a], [, b]) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt));

    const toEvict = completed.slice(0, Math.max(1, completed.length - MAX_STORED_JOBS + 100));
    for (const [id] of toEvict) {
      void this.worktreeManager.removeByJob(id).catch(() => {});
      this.jobs.delete(id);
    }

    if (toEvict.length > 0) {
      console.log(`[job-manager] Hard cap: evicted ${toEvict.length} oldest jobs`);
    }
  }

  private findWorkerJobForReview(reviewJobId: string): Job | undefined {
    const reviewJob = this.jobs.get(reviewJobId);
    if (!reviewJob) return undefined;

    let best: Job | undefined;
    for (const job of this.jobs.values()) {
      if (
        job.type === "workers" &&
        job.status === "completed" &&
        job.channelId === reviewJob.channelId &&
        job.repoPath
      ) {
        if (!best || job.completedAt! > best.completedAt!) {
          best = job;
        }
      }
    }
    return best;
  }
}
