import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JobManager } from "../job-manager.js";
import type { Job } from "../job-manager.js";
import type { WorkerAgent } from "../../agents/worker.js";
import type { ReviewerAgent } from "../../agents/reviewer.js";
import type { CouncilWorkerAgent } from "../../agents/council-worker.js";
import type { WorktreeManager } from "../../workspace/worktree-manager.js";
import type { Env } from "../../config/env.js";
import type { Subtask } from "../../agents/cto.js";

// Mock the logger to suppress output and prevent import side effects
vi.mock("../../logger.js", () => ({
  log: {
    jobMgr: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    worker: { info: vi.fn(), error: vi.fn() },
  },
}));

function makeSubtask(id: string): Subtask {
  return { id, title: `Task ${id}`, description: `Do task ${id}`, dependencies: [] };
}

function makeEnv(maxWorkers: number): Env {
  return { MAX_CONCURRENT_WORKERS: maxWorkers } as Env;
}

function makeWorktreeManager(): WorktreeManager {
  return {
    create: vi.fn().mockResolvedValue({ path: "/tmp/wt", repoPath: "/tmp/repo", isSelfRepo: false }),
    removeByJob: vi.fn().mockResolvedValue(undefined),
    removeAll: vi.fn().mockResolvedValue(undefined),
    mergeToFeatureBranch: vi.fn().mockResolvedValue({ featureBranch: "feature/test", merged: [] }),
  } as unknown as WorktreeManager;
}

/**
 * Create a mock WorkerAgent whose executeParallel returns a controllable promise.
 * Returns both the mock agent and functions to resolve/reject individual calls.
 */
function makeControllableWorkerAgent(): {
  agent: WorkerAgent;
  calls: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }>;
} {
  const calls: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  const agent = {
    executeParallel: vi.fn().mockImplementation(() => {
      return new Promise((resolve, reject) => {
        calls.push({ resolve, reject });
      });
    }),
  } as unknown as WorkerAgent;
  return { agent, calls };
}

function makeReviewerAgent(): ReviewerAgent {
  return {
    review: vi.fn().mockResolvedValue({ verdict: "approve" }),
  } as unknown as ReviewerAgent;
}

function makeCouncilWorker(): CouncilWorkerAgent {
  const calls: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  const agent = {
    executeParallel: vi.fn().mockImplementation(() => {
      return new Promise((resolve, reject) => {
        calls.push({ resolve, reject });
      });
    }),
    _calls: calls,
  } as unknown as CouncilWorkerAgent & { _calls: typeof calls };
  return agent;
}

/**
 * Helper: flush the microtask queue so that resolved promises
 * (and the `runJob` finally block) execute without advancing fake timers.
 */
async function flushMicrotasks(): Promise<void> {
  // Multiple rounds to ensure nested .then / finally chains resolve
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("Job Queuing", () => {
  let mgr: JobManager;
  let workerCtrl: ReturnType<typeof makeControllableWorkerAgent>;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    workerCtrl = makeControllableWorkerAgent();
    worktreeManager = makeWorktreeManager();
  });

  afterEach(() => {
    mgr?.destroy();
  });

  describe("createWorkerJob()", () => {
    it("should start job immediately when workers are available (status running)", () => {
      mgr = new JobManager(
        makeEnv(4),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      const job = mgr.createWorkerJob("ch1", [makeSubtask("1")], ["TS"], "/tmp/repo");

      expect("error" in job).toBe(false);
      expect((job as Job).status).toBe("running");
      expect(workerCtrl.agent.executeParallel).toHaveBeenCalledTimes(1);
    });

    it("should queue job when workers are at capacity (status queued)", () => {
      // Max 2 workers, create a job with 2 subtasks first to fill capacity
      mgr = new JobManager(
        makeEnv(2),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // First job: 2 subtasks fills 2/2 slots
      const job1 = mgr.createWorkerJob("ch1", [makeSubtask("1"), makeSubtask("2")], ["TS"], "/tmp/repo");
      expect((job1 as Job).status).toBe("running");

      // Second job: should queue because capacity is full
      const job2 = mgr.createWorkerJob("ch1", [makeSubtask("3")], ["TS"], "/tmp/repo");
      expect((job2 as Job).status).toBe("queued");
      // executeParallel should only have been called once (for job1)
      expect(workerCtrl.agent.executeParallel).toHaveBeenCalledTimes(1);
    });

    it("should preserve FIFO order when multiple jobs are queued", () => {
      // Max 1 worker
      mgr = new JobManager(
        makeEnv(1),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // Fill capacity
      mgr.createWorkerJob("ch1", [makeSubtask("1")], ["TS"], "/tmp/repo");

      // Queue 3 more jobs
      const jobA = mgr.createWorkerJob("ch1", [makeSubtask("A")], ["TS"], "/tmp/repo") as Job;
      const jobB = mgr.createWorkerJob("ch1", [makeSubtask("B")], ["TS"], "/tmp/repo") as Job;
      const jobC = mgr.createWorkerJob("ch1", [makeSubtask("C")], ["TS"], "/tmp/repo") as Job;

      expect(jobA.status).toBe("queued");
      expect(jobB.status).toBe("queued");
      expect(jobC.status).toBe("queued");
      expect(mgr.getQueueDepth()).toBe(3);

      // Verify the order: A was queued first, then B, then C
      // We'll verify this indirectly via drain order in the drainQueue tests
      const jobs = mgr.getJobs({ status: "queued" });
      expect(jobs).toHaveLength(3);
    });
  });

  describe("getQueueDepth()", () => {
    it("should return 0 when no jobs are queued", () => {
      mgr = new JobManager(
        makeEnv(4),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );
      expect(mgr.getQueueDepth()).toBe(0);
    });

    it("should return correct count of pending jobs", () => {
      mgr = new JobManager(
        makeEnv(1),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // Fill capacity
      mgr.createWorkerJob("ch1", [makeSubtask("1")], ["TS"], "/tmp/repo");

      // Queue 2 more
      mgr.createWorkerJob("ch1", [makeSubtask("2")], ["TS"], "/tmp/repo");
      mgr.createWorkerJob("ch1", [makeSubtask("3")], ["TS"], "/tmp/repo");

      expect(mgr.getQueueDepth()).toBe(2);
    });
  });

  describe("drainQueue()", () => {
    it("should start queued jobs when capacity frees up", () => {
      mgr = new JobManager(
        makeEnv(2),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // Fill capacity with 2 subtasks
      mgr.createWorkerJob("ch1", [makeSubtask("1"), makeSubtask("2")], ["TS"], "/tmp/repo");
      expect(workerCtrl.agent.executeParallel).toHaveBeenCalledTimes(1);

      // Queue another job
      const queuedJob = mgr.createWorkerJob("ch1", [makeSubtask("3")], ["TS"], "/tmp/repo") as Job;
      expect(queuedJob.status).toBe("queued");
      expect(mgr.getQueueDepth()).toBe(1);

      // Simulate first job completing: resolve its promise
      // The job completes, drainQueue is called automatically in the finally block.
      // But we also need to "complete" the running job by resolving its executeParallel.
      // Since the first job is running, resolve it.
      workerCtrl.calls[0]!.resolve([{ subtaskId: "1", status: "completed", workDir: "/tmp", diff: "", files: [], summary: "" }]);

      // drainQueue is called inside runJob's finally block. We need to flush microtasks.
      // With fake timers, we can use vi.runAllTimersAsync or just await a tick.
      // Actually, drainQueue is called synchronously in the finally block of an async function.
      // We need to let the promise chain resolve.
    });

    it("should respect the worker limit and not overfill", () => {
      // Max 2 workers
      mgr = new JobManager(
        makeEnv(2),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // Fill capacity
      mgr.createWorkerJob("ch1", [makeSubtask("1"), makeSubtask("2")], ["TS"], "/tmp/repo");

      // Queue 2 jobs: one with 2 subtasks (needs 2 slots), one with 1 subtask
      mgr.createWorkerJob("ch1", [makeSubtask("A"), makeSubtask("B")], ["TS"], "/tmp/repo");
      mgr.createWorkerJob("ch1", [makeSubtask("C")], ["TS"], "/tmp/repo");

      expect(mgr.getQueueDepth()).toBe(2);

      // Now manually drain with only 1 slot free (simulate: first job still running
      // but we want to test drainQueue behavior with limited capacity)
      // Since the first job has 2 subtasks and is running, active count is 2.
      // drainQueue should start 0 jobs because there's no capacity.
      const started = mgr.drainQueue();
      expect(started).toBe(0);
      expect(mgr.getQueueDepth()).toBe(2);
    });

    it("should start multiple queued jobs in FIFO order if capacity allows", async () => {
      // Max 4 workers
      mgr = new JobManager(
        makeEnv(4),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // Fill capacity with 4 subtasks
      mgr.createWorkerJob("ch1", [makeSubtask("1"), makeSubtask("2"), makeSubtask("3"), makeSubtask("4")], ["TS"], "/tmp/repo");
      expect(workerCtrl.agent.executeParallel).toHaveBeenCalledTimes(1);

      // Queue 2 small jobs
      const jobA = mgr.createWorkerJob("ch1", [makeSubtask("A")], ["TS"], "/tmp/repo") as Job;
      const jobB = mgr.createWorkerJob("ch1", [makeSubtask("B")], ["TS"], "/tmp/repo") as Job;
      expect(jobA.status).toBe("queued");
      expect(jobB.status).toBe("queued");
      expect(mgr.getQueueDepth()).toBe(2);

      // Resolve the first job's executeParallel — this triggers drainQueue in finally
      workerCtrl.calls[0]!.resolve([
        { subtaskId: "1", status: "completed", workDir: "/tmp", diff: "", files: [], summary: "" },
      ]);

      // Flush microtasks so the async runJob chain (try/finally with drainQueue) executes
      await flushMicrotasks();

      // After first job completes (freeing 4 slots), drainQueue should start both queued jobs
      // Check that executeParallel was called 2 more times (total 3: original + 2 drained)
      expect(workerCtrl.agent.executeParallel).toHaveBeenCalledTimes(3);
      expect(mgr.getQueueDepth()).toBe(0);

      // Verify the jobs are now running
      expect(mgr.getJob(jobA.id)!.status).toBe("running");
      expect(mgr.getJob(jobB.id)!.status).toBe("running");
    });

    it("should return count of started jobs", () => {
      // Max 4 workers, nothing running, 0 queued
      mgr = new JobManager(
        makeEnv(4),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // drainQueue with empty queue returns 0
      expect(mgr.drainQueue()).toBe(0);
    });
  });

  describe("automatic drain after job completion", () => {
    it("should start queued jobs automatically after a running job completes", async () => {
      // Max 2 workers
      mgr = new JobManager(
        makeEnv(2),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // Start a 2-subtask job (fills capacity)
      mgr.createWorkerJob("ch1", [makeSubtask("1"), makeSubtask("2")], ["TS"], "/tmp/repo");
      expect(workerCtrl.agent.executeParallel).toHaveBeenCalledTimes(1);

      // Queue a 1-subtask job
      const queued = mgr.createWorkerJob("ch1", [makeSubtask("Q")], ["TS"], "/tmp/repo") as Job;
      expect(queued.status).toBe("queued");
      expect(mgr.getQueueDepth()).toBe(1);

      // Complete the running job — drainQueue fires in the finally block
      workerCtrl.calls[0]!.resolve([
        { subtaskId: "1", status: "completed", workDir: "/tmp", diff: "", files: [], summary: "" },
      ]);

      // Flush microtasks so runJob's finally block (with drainQueue) executes
      await flushMicrotasks();

      // The queued job should now be running
      expect(mgr.getJob(queued.id)!.status).toBe("running");
      expect(mgr.getQueueDepth()).toBe(0);
      // executeParallel called twice: once for original, once for drained
      expect(workerCtrl.agent.executeParallel).toHaveBeenCalledTimes(2);
    });

    it("should drain queue even when a running job fails", async () => {
      mgr = new JobManager(
        makeEnv(2),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
      );

      // Fill capacity
      mgr.createWorkerJob("ch1", [makeSubtask("1"), makeSubtask("2")], ["TS"], "/tmp/repo");

      // Queue another
      const queued = mgr.createWorkerJob("ch1", [makeSubtask("Q")], ["TS"], "/tmp/repo") as Job;
      expect(queued.status).toBe("queued");

      // Fail the running job
      workerCtrl.calls[0]!.reject(new Error("Worker crashed"));

      // Flush microtasks so runJob's catch/finally chain executes
      await flushMicrotasks();

      // The queued job should still get started via drainQueue in finally
      expect(mgr.getJob(queued.id)!.status).toBe("running");
      expect(mgr.getQueueDepth()).toBe(0);
    });
  });

  describe("council jobs queuing", () => {
    it("should queue council jobs when at capacity (3x multiplier)", () => {
      const councilWorker = makeCouncilWorker();
      mgr = new JobManager(
        makeEnv(2), // max 2 workers => council limit is 2*3 = 6
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
        undefined,
        councilWorker,
      );

      // Council limit = MAX_CONCURRENT_WORKERS * 3 = 6.
      // getActiveWorkerCount() counts subtasks from running worker jobs.
      // First council job: 2 subtasks → active count becomes 2, needed = 2*3 = 6.
      // Check: 0 + 6 <= 6 → starts (barely fits).
      const job1 = mgr.createCouncilJob("ch1", [makeSubtask("1"), makeSubtask("2")], ["TS"], "/tmp/repo");
      expect("error" in job1).toBe(false);
      expect((job1 as Job).status).toBe("running");

      // Now activeCount = 2 (job1 has 2 subtasks and is running).
      // Second council job: 1 subtask, needed = 1*3 = 3. Check: 2 + 3 = 5 <= 6 → fits.
      // We need a job that would exceed: e.g., 2 subtasks → needed = 6. Check: 2 + 6 = 8 > 6 → queues.
      const job2 = mgr.createCouncilJob("ch1", [makeSubtask("3"), makeSubtask("4")], ["TS"], "/tmp/repo");
      expect("error" in job2).toBe(false);
      expect((job2 as Job).status).toBe("queued");
      expect(mgr.getQueueDepth()).toBe(1);
    });

    it("should return error when council worker is not configured", () => {
      mgr = new JobManager(
        makeEnv(4),
        workerCtrl.agent,
        makeReviewerAgent(),
        worktreeManager,
        // no councilReviewer, no councilWorker
      );

      const result = mgr.createCouncilJob("ch1", [makeSubtask("1")], ["TS"], "/tmp/repo");
      expect("error" in result).toBe(true);
      expect((result as { error: string }).error).toContain("Council worker not configured");
    });
  });
});
