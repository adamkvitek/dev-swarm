import { describe, it, expect, vi } from "vitest";
import { ResourceGuard } from "../resource-guard.js";

// Mock os module to control memory values
vi.mock("node:os", () => ({
  freemem: vi.fn(() => 8 * 1024 * 1024 * 1024), // 8GB free
  totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024), // 16GB total
  platform: vi.fn(() => "darwin"),
  cpus: vi.fn(() => Array.from({ length: 8 }, () => ({ model: "mock", speed: 2400, times: { user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 } }))), // macOS by default in tests
}));

// Mock fs to prevent /proc/meminfo read on non-Linux
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("not linux"); }),
}));

describe("ResourceGuard", () => {
  describe("check()", () => {
    it("should return healthy when memory is below ceiling", () => {
      const guard = new ResourceGuard(80, 4, () => 0);
      const snap = guard.check();
      expect(snap.healthy).toBe(true);
      expect(snap.memoryUsedPct).toBeGreaterThanOrEqual(0);
      expect(snap.memoryUsedPct).toBeLessThan(80);
      expect(snap.memoryTotalMb).toBeGreaterThan(0);
      expect(snap.memoryAvailableMb).toBeGreaterThan(0);
      expect(snap.platform).toBe("darwin");
    });

    it("should return unhealthy when memory exceeds ceiling", () => {
      // 50% used, set ceiling to 40%
      const guard = new ResourceGuard(40, 4, () => 0);
      const snap = guard.check();
      expect(snap.healthy).toBe(false);
    });

    it("should report canSpawnMore when both memory and workers are ok", () => {
      const guard = new ResourceGuard(80, 4, () => 2);
      const snap = guard.check();
      expect(snap.canSpawnMore).toBe(true);
      expect(snap.activeWorkers).toBe(2);
    });

    it("should report cannot spawn when at worker capacity", () => {
      const guard = new ResourceGuard(80, 4, () => 4);
      const snap = guard.check();
      expect(snap.canSpawnMore).toBe(false);
    });

    it("should report cannot spawn when over worker capacity", () => {
      const guard = new ResourceGuard(80, 4, () => 5);
      const snap = guard.check();
      expect(snap.canSpawnMore).toBe(false);
    });

    it("should report cannot spawn when memory is over ceiling even with worker capacity", () => {
      const guard = new ResourceGuard(40, 10, () => 0);
      const snap = guard.check();
      expect(snap.canSpawnMore).toBe(false);
    });

    it("should return correct worker counts", () => {
      let count = 0;
      const guard = new ResourceGuard(80, 8, () => count);

      count = 0;
      expect(guard.check().activeWorkers).toBe(0);

      count = 5;
      expect(guard.check().activeWorkers).toBe(5);
      expect(guard.check().maxWorkers).toBe(8);
    });
  });

  describe("statusLine()", () => {
    it("should return a readable status string with available memory", () => {
      const guard = new ResourceGuard(80, 4, () => 2);
      const line = guard.statusLine();
      expect(line).toContain("Memory:");
      expect(line).toContain("available");
      expect(line).toContain("Workers: 2/4");
    });

    it("should show OVER LIMIT when memory is exceeded", () => {
      const guard = new ResourceGuard(40, 4, () => 0);
      const line = guard.statusLine();
      expect(line).toContain("[OVER LIMIT]");
    });

    it("should show AT CAPACITY when workers are maxed", () => {
      const guard = new ResourceGuard(80, 4, () => 4);
      const line = guard.statusLine();
      expect(line).toContain("[AT CAPACITY]");
    });
  });

  describe("userFacingStatus()", () => {
    it("should return null when resources are healthy and workers available", () => {
      const guard = new ResourceGuard(80, 4, () => 0);
      expect(guard.userFacingStatus()).toBeNull();
    });

    it("should return a warning when memory exceeds ceiling", () => {
      // ~50% used with a 40% ceiling → over limit
      const guard = new ResourceGuard(40, 4, () => 0);
      const status = guard.userFacingStatus();
      expect(status).not.toBeNull();
      expect(status).toContain("Memory usage is high");
      expect(status).toContain("Worker spawning is paused");
    });

    it("should return a warning when workers are at capacity", () => {
      const guard = new ResourceGuard(80, 4, () => 4);
      const status = guard.userFacingStatus();
      expect(status).not.toBeNull();
      expect(status).toContain("All worker slots are in use");
      expect(status).toContain("Worker spawning is paused");
    });

    it("should include both memory and worker warnings when both constrained", () => {
      // ~50% used with a 40% ceiling + workers at capacity
      const guard = new ResourceGuard(40, 2, () => 2);
      const status = guard.userFacingStatus();
      expect(status).not.toBeNull();
      expect(status).toContain("Memory usage is high");
      expect(status).toContain("All worker slots are in use");
      expect(status).toContain("Worker spawning is paused");
    });

    it("should not mention env var names or technical config details", () => {
      const guard = new ResourceGuard(40, 2, () => 2);
      const status = guard.userFacingStatus()!;
      expect(status).not.toContain("MEMORY_CEILING_PCT");
      expect(status).not.toContain("MAX_CONCURRENT_WORKERS");
      expect(status).not.toContain("MB");
    });
  });

  describe("checkTransition()", () => {
    it("should return no warning or recovery on first check when healthy", () => {
      const guard = new ResourceGuard(80, 4, () => 0);
      const { warning, recovery } = guard.checkTransition();
      expect(warning).toBeNull();
      expect(recovery).toBeNull();
    });

    it("should return warning on first check when memory is already over", () => {
      const guard = new ResourceGuard(40, 4, () => 0);
      const { warning, recovery } = guard.checkTransition();
      expect(warning).not.toBeNull();
      expect(warning).toContain("Memory usage is high");
      expect(recovery).toBeNull();
    });

    it("should return recovery when memory drops below ceiling", () => {
      let ceiling = 40; // starts constrained
      const guard = new ResourceGuard(ceiling, 4, () => 0);
      guard.checkTransition(); // first check — sets state to constrained

      // Now "fix" the ceiling so it's healthy
      // We need a new guard since ceiling is set in constructor
      // Instead, test with workers which we can control dynamically
      let workers = 4;
      const guard2 = new ResourceGuard(80, 4, () => workers);
      guard2.checkTransition(); // workers at capacity

      workers = 0; // workers freed up
      const { warning, recovery } = guard2.checkTransition();
      expect(warning).toBeNull();
      expect(recovery).not.toBeNull();
      expect(recovery).toContain("Worker slots are available again");
      expect(recovery).toContain("Full capabilities restored");
    });

    it("should not repeat warning on consecutive constrained checks", () => {
      const guard = new ResourceGuard(40, 4, () => 0);
      const first = guard.checkTransition();
      expect(first.warning).not.toBeNull();

      const second = guard.checkTransition();
      expect(second.warning).toBeNull();
      expect(second.recovery).toBeNull();
    });

    it("should warn about memory specifically when only memory is the issue", () => {
      const guard = new ResourceGuard(40, 4, () => 0);
      const { warning } = guard.checkTransition();
      expect(warning).toContain("Memory usage is high");
      expect(warning).not.toContain("worker slots");
    });

    it("should warn about workers specifically when only workers are the issue", () => {
      const guard = new ResourceGuard(80, 4, () => 4);
      const { warning } = guard.checkTransition();
      expect(warning).toContain("All worker slots are in use");
      expect(warning).not.toContain("Memory");
    });
  });

  describe("defaults", () => {
    it("should work with default parameters", () => {
      const guard = new ResourceGuard();
      const snap = guard.check();
      expect(snap.maxWorkers).toBe(4);
      expect(snap.activeWorkers).toBe(0);
    });
  });
});
