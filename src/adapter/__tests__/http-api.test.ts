import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpApi } from "../http-api.js";
import type { JobManager, Job, JobStatus } from "../job-manager.js";
import type { ResourceGuard, ResourceSnapshot } from "../resource-guard.js";

// Minimal mocks — only what HttpApi calls
function createMockJobManager(): JobManager {
  const jobs = new Map<string, Job>();
  return {
    createWorkerJob: (_ch: string, _st: unknown[], _ts: string[], _rp: string) => {
      const job: Job = { id: "job-123", channelId: "ch1", type: "workers", status: "running", createdAt: Date.now() };
      jobs.set(job.id, job);
      return job;
    },
    createReviewJob: (_ch: string, _wj: string, _td: string, _it: number) => {
      return { error: "Worker job not found" };
    },
    cancelJob: (id: string) => jobs.has(id),
    getJob: (id: string) => jobs.get(id),
    getJobs: (_f?: { channelId?: string; status?: JobStatus }) => Array.from(jobs.values()),
    getActiveWorkerCount: () => 0,
  } as unknown as JobManager;
}

function createMockResourceGuard(): ResourceGuard {
  return {
    check: (): ResourceSnapshot => ({
      memoryUsedPct: 45,
      memoryUsedMb: 7200,
      memoryTotalMb: 16000,
      activeWorkers: 0,
      maxWorkers: 4,
      canSpawnMore: true,
      healthy: true,
    }),
    statusLine: () => "Memory: 7200MB / 16000MB (45%) | Workers: 0/4",
  } as unknown as ResourceGuard;
}

describe("HttpApi", () => {
  let api: HttpApi;
  let baseUrl: string;

  beforeAll(async () => {
    const jobManager = createMockJobManager();
    const resourceGuard = createMockResourceGuard();
    api = new HttpApi(jobManager, resourceGuard);
    // Use port 0 to let OS assign a free port
    await api.start("127.0.0.1", 0);
    const addr = (api as unknown as { server: { address: () => { port: number } } }).server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await api.stop();
  });

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${api.token}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  describe("GET /health", () => {
    it("should return health without auth", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("ok");
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(body.memory.healthy).toBe(true);
      expect(body.workers.active).toBe(0);
    });
  });

  describe("auth", () => {
    it("should reject requests without token", async () => {
      const res = await fetch(`${baseUrl}/jobs`);
      expect(res.status).toBe(401);
    });

    it("should reject requests with wrong token", async () => {
      const res = await fetch(`${baseUrl}/jobs`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it("should accept requests with valid token", async () => {
      const res = await fetch(`${baseUrl}/jobs`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /jobs/workers", () => {
    it("should reject missing fields", async () => {
      const res = await fetch(`${baseUrl}/jobs/workers`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: "ch1" }),
      });
      expect(res.status).toBe(400);
    });

    it("should reject relative repoPath", async () => {
      const res = await fetch(`${baseUrl}/jobs/workers`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: "ch1",
          repoPath: "../escape",
          subtasks: [{ id: "1", title: "test", description: "test", dependencies: [] }],
          techStack: ["TypeScript"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("absolute");
    });

    it("should reject system dir repoPath", async () => {
      const res = await fetch(`${baseUrl}/jobs/workers`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: "ch1",
          repoPath: "/etc/passwd",
          subtasks: [{ id: "1", title: "test", description: "test", dependencies: [] }],
          techStack: ["TypeScript"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("system directory");
    });

    it("should reject subtasks with dangerous IDs", async () => {
      const res = await fetch(`${baseUrl}/jobs/workers`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: "ch1",
          repoPath: "/tmp/test-repo",
          subtasks: [{ id: "id; rm -rf /", title: "test", description: "test", dependencies: [] }],
          techStack: ["TypeScript"],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("should accept valid request", async () => {
      const res = await fetch(`${baseUrl}/jobs/workers`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: "ch1",
          repoPath: "/tmp/test-repo",
          subtasks: [{ id: "task-1", title: "Add auth", description: "Implement JWT", dependencies: [] }],
          techStack: ["TypeScript"],
        }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.job_id).toBeDefined();
      expect(body.status).toBe("running");
    });
  });

  describe("GET /resources", () => {
    it("should return resource snapshot", async () => {
      const res = await fetch(`${baseUrl}/resources`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.memoryUsedPct).toBe(45);
      expect(body.healthy).toBe(true);
    });
  });

  describe("404", () => {
    it("should return 404 for unknown paths", async () => {
      const res = await fetch(`${baseUrl}/unknown`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });
});
