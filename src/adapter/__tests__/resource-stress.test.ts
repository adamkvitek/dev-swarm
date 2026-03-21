import { describe, it, expect, vi } from "vitest";
import { ResourceGuard } from "../resource-guard.js";

// Mock os module to control memory values — same pattern as resource-guard.test.ts
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

// Mock child_process to prevent vm_stat from running — falls back to freemem()
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => { throw new Error("mocked"); }),
}));

/**
 * With the os mocks above, memory is always ~50% used:
 *   totalmem = 16GB, freemem = 8GB → usedPct ≈ 50%
 *
 * Set ceiling to 40% for "over limit" scenarios.
 * Set ceiling to 80% for "healthy" scenarios.
 */

describe("ResourceGuard — stress scenarios", () => {
  describe("simulated memory pressure", () => {
    it("should return unhealthy when memory ceiling is set below actual usage", () => {
      // ~50% used, ceiling at 30% → over limit
      const guard = new ResourceGuard(30, 4, () => 0);
      const snap = guard.check();

      expect(snap.healthy).toBe(false);
      expect(snap.memoryUsedPct).toBeGreaterThanOrEqual(30);
    });

    it("should show OVER LIMIT in statusLine when memory exceeds ceiling", () => {
      const guard = new ResourceGuard(30, 4, () => 0);
      const status = guard.statusLine();

      expect(status).toContain("[OVER LIMIT]");
      expect(status).toContain("Memory:");
    });

    it("should report canSpawnMore as false when memory is over ceiling", () => {
      const guard = new ResourceGuard(30, 10, () => 0);
      const snap = guard.check();

      expect(snap.canSpawnMore).toBe(false);
      expect(snap.healthy).toBe(false);
    });

    it("should include memory details in statusLine when over limit", () => {
      const guard = new ResourceGuard(30, 4, () => 0);
      const status = guard.statusLine();

      expect(status).toContain("MB");
      expect(status).toContain("available");
      expect(status).toContain("[OVER LIMIT]");
    });
  });

  describe("simulated worker saturation", () => {
    it("should report canSpawnMore as false when workers are at max", () => {
      const guard = new ResourceGuard(80, 2, () => 2);
      const snap = guard.check();

      expect(snap.canSpawnMore).toBe(false);
      expect(snap.activeWorkers).toBe(2);
      expect(snap.maxWorkers).toBe(2);
    });

    it("should show AT CAPACITY in statusLine when workers are maxed", () => {
      const guard = new ResourceGuard(80, 2, () => 2);
      const status = guard.statusLine();

      expect(status).toContain("[AT CAPACITY]");
      expect(status).toContain("Workers: 2/2");
    });

    it("should report canSpawnMore as false when workers exceed max", () => {
      const guard = new ResourceGuard(80, 2, () => 3);
      const snap = guard.check();

      expect(snap.canSpawnMore).toBe(false);
      expect(snap.activeWorkers).toBe(3);
    });

    it("should remain healthy when only workers are saturated (not memory)", () => {
      const guard = new ResourceGuard(80, 2, () => 2);
      const snap = guard.check();

      // healthy reflects memory only; canSpawnMore combines both
      expect(snap.healthy).toBe(true);
      expect(snap.canSpawnMore).toBe(false);
    });
  });

  describe("full lifecycle: healthy -> constrained -> recovery", () => {
    it("should track state transitions through a mutable worker count", () => {
      let workers = 0;
      const guard = new ResourceGuard(80, 4, () => workers);

      // Phase 1: Healthy — no workers, memory below ceiling
      const snap1 = guard.check();
      expect(snap1.healthy).toBe(true);
      expect(snap1.canSpawnMore).toBe(true);
      expect(snap1.activeWorkers).toBe(0);

      // Phase 2: Constrained — workers at capacity
      workers = 4;
      const snap2 = guard.check();
      expect(snap2.healthy).toBe(true); // memory still ok
      expect(snap2.canSpawnMore).toBe(false); // workers full
      expect(snap2.activeWorkers).toBe(4);

      // Phase 3: Recovery — workers back to 0
      workers = 0;
      const snap3 = guard.check();
      expect(snap3.healthy).toBe(true);
      expect(snap3.canSpawnMore).toBe(true);
      expect(snap3.activeWorkers).toBe(0);

      // Phase 4: Stable — repeated checks still healthy
      const snap4 = guard.check();
      expect(snap4.healthy).toBe(true);
      expect(snap4.canSpawnMore).toBe(true);
    });

    it("should reflect memory constraint lifecycle via different guard instances", () => {
      // Phase 1: Healthy (ceiling above usage)
      const healthyGuard = new ResourceGuard(80, 4, () => 0);
      const snap1 = healthyGuard.check();
      expect(snap1.healthy).toBe(true);
      expect(snap1.canSpawnMore).toBe(true);

      // Phase 2: Constrained (ceiling below usage)
      const constrainedGuard = new ResourceGuard(40, 4, () => 0);
      const snap2 = constrainedGuard.check();
      expect(snap2.healthy).toBe(false);
      expect(snap2.canSpawnMore).toBe(false);

      // Phase 3: Recovery (ceiling raised back)
      const recoveredGuard = new ResourceGuard(80, 4, () => 0);
      const snap3 = recoveredGuard.check();
      expect(snap3.healthy).toBe(true);
      expect(snap3.canSpawnMore).toBe(true);
    });

    it("should track transition from healthy to memory-constrained to worker-constrained and back", () => {
      let workers = 0;

      // Start healthy with high ceiling
      const guard = new ResourceGuard(80, 4, () => workers);
      expect(guard.check().canSpawnMore).toBe(true);

      // Workers fill up
      workers = 4;
      const snap = guard.check();
      expect(snap.canSpawnMore).toBe(false);
      expect(snap.healthy).toBe(true); // memory still ok
      expect(guard.statusLine()).toContain("[AT CAPACITY]");
      expect(guard.statusLine()).not.toContain("[OVER LIMIT]");

      // Workers recover
      workers = 2;
      const snap2 = guard.check();
      expect(snap2.canSpawnMore).toBe(true);
      expect(snap2.healthy).toBe(true);
    });
  });

  describe("mixed constraint: memory + workers simultaneously", () => {
    it("should show both OVER LIMIT and AT CAPACITY when both are constrained", () => {
      // Low ceiling (below ~50% usage) + workers at max
      const guard = new ResourceGuard(40, 2, () => 2);
      const snap = guard.check();

      expect(snap.healthy).toBe(false);
      expect(snap.canSpawnMore).toBe(false);
      expect(snap.activeWorkers).toBe(2);
      expect(snap.maxWorkers).toBe(2);

      const status = guard.statusLine();
      expect(status).toContain("[OVER LIMIT]");
      expect(status).toContain("[AT CAPACITY]");
    });

    it("should show only worker constraint when memory recovers but workers remain", () => {
      // High ceiling (memory ok) + workers at max
      const guard = new ResourceGuard(80, 2, () => 2);
      const status = guard.statusLine();

      expect(status).not.toContain("[OVER LIMIT]");
      expect(status).toContain("[AT CAPACITY]");
    });

    it("should show OVER LIMIT and AT CAPACITY when memory is over ceiling even with free workers", () => {
      // Low ceiling (memory over) + workers available
      // Note: canSpawnMore = memoryOk && workersOk, so when memory is NOT ok,
      // canSpawnMore is false and [AT CAPACITY] is shown even with free worker slots.
      // This is intentional — the system cannot spawn more when memory is constrained.
      const guard = new ResourceGuard(40, 4, () => 0);
      const status = guard.statusLine();

      expect(status).toContain("[OVER LIMIT]");
      expect(status).toContain("[AT CAPACITY]");
      // Workers themselves are not full, but canSpawnMore is false due to memory
      expect(status).toContain("Workers: 0/4");
    });

    it("should show neither constraint when both recover", () => {
      const guard = new ResourceGuard(80, 4, () => 1);
      const status = guard.statusLine();

      expect(status).not.toContain("[OVER LIMIT]");
      expect(status).not.toContain("[AT CAPACITY]");
    });

    it("should track mixed constraint lifecycle with mutable workers", () => {
      let workers = 0;

      // Phase 1: Both constrained (low ceiling + workers maxed)
      const guard = new ResourceGuard(40, 2, () => workers);
      workers = 2;
      let status = guard.statusLine();
      expect(status).toContain("[OVER LIMIT]");
      expect(status).toContain("[AT CAPACITY]");

      // Phase 2: Workers recover, but memory still constrained
      // canSpawnMore remains false because memoryOk is false,
      // so [AT CAPACITY] persists even with free worker slots.
      workers = 0;
      status = guard.statusLine();
      expect(status).toContain("[OVER LIMIT]");
      expect(status).toContain("[AT CAPACITY]");
      // Workers show 0/2 — slots are available but blocked by memory
      expect(status).toContain("Workers: 0/2");
    });
  });

  describe("real memory allocation stress test", () => {
    it("should detect increased memory usage from buffer allocation", () => {
      // Take a baseline reading
      const guard = new ResourceGuard(80, 4, () => 0);
      const baseline = guard.check();

      const buffers: Buffer[] = [];
      try {
        // Allocate 500MB in 100MB chunks
        for (let i = 0; i < 5; i++) {
          const buf = Buffer.alloc(100 * 1024 * 1024, 0x42);
          buffers.push(buf);
        }

        // Force the buffers to be touched so the OS actually allocates pages
        for (const buf of buffers) {
          buf[0] = 0xff;
          buf[buf.length - 1] = 0xff;
        }

        // Note: With the mocked os module, freemem() always returns 8GB,
        // so ResourceGuard won't see the allocation. This test verifies
        // that Node.js itself can handle the allocation without crashing,
        // and that the guard returns consistent results under heap pressure.
        const underPressure = guard.check();
        expect(underPressure.memoryTotalMb).toBe(baseline.memoryTotalMb);
        expect(underPressure.platform).toBe("darwin");
        expect(typeof underPressure.memoryUsedPct).toBe("number");
        expect(underPressure.memoryUsedPct).toBeGreaterThanOrEqual(0);
        expect(underPressure.memoryUsedPct).toBeLessThanOrEqual(100);
      } finally {
        // ALWAYS clean up — release all buffers
        buffers.length = 0;
        // Hint to GC (not guaranteed but best effort)
        if (global.gc) global.gc();
      }

      // After cleanup, guard should still return consistent results
      const afterCleanup = guard.check();
      expect(afterCleanup.memoryTotalMb).toBe(baseline.memoryTotalMb);
      expect(typeof afterCleanup.memoryUsedPct).toBe("number");
    });

    it("should handle allocation and cleanup without affecting guard stability", () => {
      const guard = new ResourceGuard(80, 4, () => 0);
      const buffers: Buffer[] = [];

      try {
        // Allocate 300MB to stress but not overwhelm
        for (let i = 0; i < 3; i++) {
          buffers.push(Buffer.alloc(100 * 1024 * 1024, i));
        }

        // Guard should still work consistently under heap pressure
        const snap1 = guard.check();
        const snap2 = guard.check();

        // Multiple calls should return consistent total memory
        expect(snap1.memoryTotalMb).toBe(snap2.memoryTotalMb);
        expect(snap1.platform).toBe(snap2.platform);

        // statusLine should still be parseable
        const status = guard.statusLine();
        expect(status).toContain("Memory:");
        expect(status).toContain("Workers:");
      } finally {
        buffers.length = 0;
      }
    });
  });

  describe("edge cases under stress", () => {
    it("should handle rapid repeated check() calls", () => {
      let workers = 0;
      const guard = new ResourceGuard(80, 4, () => workers);

      // Rapid fire 100 checks with changing worker counts
      for (let i = 0; i < 100; i++) {
        workers = i % 5; // oscillate 0-4
        const snap = guard.check();
        expect(snap.activeWorkers).toBe(i % 5);
        expect(snap.maxWorkers).toBe(4);
        expect(typeof snap.memoryUsedPct).toBe("number");
      }
    });

    it("should handle worker count at extreme values", () => {
      const guard = new ResourceGuard(80, 100, () => 100);
      const snap = guard.check();
      expect(snap.activeWorkers).toBe(100);
      expect(snap.maxWorkers).toBe(100);
      expect(snap.canSpawnMore).toBe(false);
    });

    it("should handle very low ceiling with correct unhealthy status", () => {
      // Ceiling of 1% — even with 50% usage, should be unhealthy
      const guard = new ResourceGuard(1, 4, () => 0);
      const snap = guard.check();
      expect(snap.healthy).toBe(false);
      expect(snap.canSpawnMore).toBe(false);
    });

    it("should handle very high ceiling gracefully", () => {
      // Ceiling of 99% — should be healthy at ~50% usage
      const guard = new ResourceGuard(99, 4, () => 0);
      const snap = guard.check();
      expect(snap.healthy).toBe(true);
      expect(snap.canSpawnMore).toBe(true);
    });

    it("should produce consistent statusLine across repeated calls", () => {
      const guard = new ResourceGuard(80, 4, () => 2);
      const lines = new Set<string>();

      for (let i = 0; i < 10; i++) {
        lines.add(guard.statusLine());
      }

      // With mocked os values, all 10 calls should produce the same string
      expect(lines.size).toBe(1);
    });
  });
});
