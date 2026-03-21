import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { log } from "../logger.js";
import type { JobManager, JobStatus } from "./job-manager.js";
import type { ResourceGuard } from "./resource-guard.js";
import {
  validateRepoPath,
  validateSubtasks,
  validateTechStack,
  validateSafeText,
  ValidationError,
} from "./validation.js";

const MAX_BODY_BYTES = 1_048_576; // 1MB

/**
 * Internal HTTP server for MCP ↔ adapter bridge.
 *
 * Bound to 127.0.0.1 only — never exposed externally.
 * Requires a bearer token on every request (generated at startup,
 * passed to MCP server via DEV_SWARM_API_TOKEN env var).
 */
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_JOBS = 5; // max 5 job creations per channel per minute

export class HttpApi {
  private server: Server;
  private jobManager: JobManager;
  private resourceGuard: ResourceGuard;
  private rateLimits = new Map<string, number[]>();
  readonly token: string;

  constructor(jobManager: JobManager, resourceGuard: ResourceGuard, existingToken?: string) {
    this.jobManager = jobManager;
    this.resourceGuard = resourceGuard;
    this.token = existingToken ?? randomBytes(32).toString("hex");

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  async start(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", reject);
        log.httpApi.info({ host, port }, "Listening");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        log.httpApi.info("Stopped");
        resolve();
      });
    });
  }

  /**
   * Per-channel rate limiting. Returns true if the request is allowed.
   */
  private checkRateLimit(channelId: string): boolean {
    const now = Date.now();
    const timestamps = this.rateLimits.get(channelId) ?? [];
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX_JOBS) {
      return false;
    }
    recent.push(now);
    this.rateLimits.set(channelId, recent);
    return true;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    // Health check — no auth required
    if (method === "GET" && path === "/health") {
      const snap = this.resourceGuard.check();
      return sendJson(res, 200, {
        status: "ok",
        uptime: Math.round(process.uptime()),
        memory: { usedPct: snap.memoryUsedPct, healthy: snap.healthy },
        workers: { active: snap.activeWorkers, max: snap.maxWorkers },
      });
    }

    // Auth check — reject requests without valid bearer token
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${this.token}`) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    try {
      // POST /jobs/workers
      if (method === "POST" && path === "/jobs/workers") {
        const body = await readBody(req);

        // Validate all inputs before passing to business logic
        const channelId = body.channelId;
        if (typeof channelId !== "string" || channelId.length === 0) {
          return sendJson(res, 400, { error: "channelId is required" });
        }

        // Rate limiting per channel
        if (!this.checkRateLimit(channelId)) {
          return sendJson(res, 429, {
            error: `Rate limited: max ${RATE_LIMIT_MAX_JOBS} job creations per minute per channel`,
          });
        }

        const repoPath = validateRepoPath(body.repoPath);
        const subtasks = validateSubtasks(body.subtasks);
        const techStack = validateTechStack(body.techStack);
        const previousFeedback = body.previousFeedback != null
          ? validateSafeText(body.previousFeedback, "previousFeedback", 10_000)
          : undefined;

        // Reject if queue is already deep — prevents unbounded growth
        const MAX_QUEUE_DEPTH = 10;
        if (this.jobManager.getQueueDepth() >= MAX_QUEUE_DEPTH) {
          return sendJson(res, 429, {
            error: `Queue is full (${MAX_QUEUE_DEPTH} jobs waiting). Wait for running jobs to finish.`,
            queue_depth: this.jobManager.getQueueDepth(),
          });
        }

        const job = this.jobManager.createWorkerJob(
          channelId,
          subtasks,
          techStack,
          repoPath,
          previousFeedback,
        );

        const status = job.status === "queued" ? 202 : 201; // 202 Accepted = queued
        return sendJson(res, status, {
          job_id: job.id,
          status: job.status,
          queued: job.status === "queued",
          queue_depth: this.jobManager.getQueueDepth(),
        });
      }

      // POST /jobs/council
      if (method === "POST" && path === "/jobs/council") {
        const body = await readBody(req);

        const channelId = body.channelId;
        if (typeof channelId !== "string" || channelId.length === 0) {
          return sendJson(res, 400, { error: "channelId is required" });
        }

        if (!this.checkRateLimit(channelId)) {
          return sendJson(res, 429, {
            error: `Rate limited: max ${RATE_LIMIT_MAX_JOBS} job creations per minute per channel`,
          });
        }

        const repoPath = validateRepoPath(body.repoPath);
        const subtasks = validateSubtasks(body.subtasks);
        const techStack = validateTechStack(body.techStack);
        const previousFeedback = body.previousFeedback != null
          ? validateSafeText(body.previousFeedback, "previousFeedback", 10_000)
          : undefined;

        const result = this.jobManager.createCouncilJob(
          channelId,
          subtasks,
          techStack,
          repoPath,
          previousFeedback,
        );

        if ("error" in result) {
          return sendJson(res, 429, result);
        }
        return sendJson(res, 201, { job_id: result.id, status: result.status, mode: "council" });
      }

      // POST /jobs/review
      if (method === "POST" && path === "/jobs/review") {
        const body = await readBody(req);
        const channelId = body.channelId as string | undefined;
        const workerJobId = body.workerJobId as string | undefined;
        const taskDescription = body.taskDescription as string | undefined;
        const iteration = body.iteration as number | undefined;

        if (!channelId || !workerJobId || !taskDescription || iteration == null) {
          return sendJson(res, 400, {
            error: "channelId, workerJobId, taskDescription, and iteration are required",
          });
        }

        const result = this.jobManager.createReviewJob(
          channelId,
          workerJobId,
          taskDescription,
          iteration,
        );

        if ("error" in result) {
          return sendJson(res, 400, result);
        }
        return sendJson(res, 201, { job_id: result.id, status: result.status });
      }

      // GET /jobs
      if (method === "GET" && path === "/jobs") {
        const channelId = url.searchParams.get("channelId") ?? undefined;
        const status = (url.searchParams.get("status") as JobStatus) ?? undefined;
        const jobs = this.jobManager.getJobs({ channelId, status });
        return sendJson(res, 200, {
          jobs: jobs.map((j) => ({
            id: j.id,
            channelId: j.channelId,
            type: j.type,
            status: j.status,
            createdAt: j.createdAt,
            completedAt: j.completedAt,
          })),
        });
      }

      // GET /jobs/:id and GET /jobs/:id/result, POST /jobs/:id/cancel
      const jobMatch = path.match(/^\/jobs\/([a-f0-9-]+)(\/(?:result|cancel))?$/);
      if (jobMatch) {
        const jobId = jobMatch[1];
        const suffix = jobMatch[2];

        // POST /jobs/:id/cancel
        if (method === "POST" && suffix === "/cancel") {
          const cancelled = this.jobManager.cancelJob(jobId);
          if (!cancelled) {
            return sendJson(res, 404, { error: "Job not found or not running" });
          }
          return sendJson(res, 200, { cancelled: true });
        }

        if (method !== "GET") {
          return sendJson(res, 405, { error: "Method not allowed" });
        }

        const job = this.jobManager.getJob(jobId);
        if (!job) {
          return sendJson(res, 404, { error: "Job not found" });
        }

        // GET /jobs/:id/result
        if (suffix === "/result") {
          if (job.status !== "completed" && job.status !== "failed") {
            return sendJson(res, 409, {
              error: `Job is still ${job.status} — result not available yet`,
            });
          }
          return sendJson(res, 200, {
            id: job.id,
            type: job.type,
            status: job.status,
            workerResults: job.type === "workers" ? job.workerResults : undefined,
            reviewResult: job.type === "review" ? job.reviewResult : undefined,
            error: job.error,
          });
        }

        // GET /jobs/:id
        return sendJson(res, 200, {
          id: job.id,
          channelId: job.channelId,
          type: job.type,
          status: job.status,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          subtaskCount: job.type === "workers" ? job.subtasks.length : undefined,
          error: job.error,
        });
      }

      // GET /resources
      if (method === "GET" && path === "/resources") {
        const snap = this.resourceGuard.check();
        return sendJson(res, 200, snap);
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof ValidationError) {
        return sendJson(res, 400, { error: err.message });
      }
      log.httpApi.error({ err, method, path }, "Error handling request");
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_BYTES) {
        req.destroy(new Error("Request body too large"));
        reject(new Error("Request body exceeds 1MB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : err}`));
      }
    });
    req.on("error", reject);
  });
}
