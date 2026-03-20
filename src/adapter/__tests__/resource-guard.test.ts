import { describe, it, expect, vi } from "vitest";
import { ResourceGuard } from "../resource-guard.js";

// Mock os module to control memory values
vi.mock("node:os", () => ({
  freemem: vi.fn(() => 8 * 1024 * 1024 * 1024), // 8GB free
  totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024), // 16GB total
  platform: vi.fn(() => "darwin"), // macOS by default in tests
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

  describe("defaults", () => {
    it("should work with default parameters", () => {
      const guard = new ResourceGuard();
      const snap = guard.check();
      expect(snap.maxWorkers).toBe(4);
      expect(snap.activeWorkers).toBe(0);
    });
  });
});
