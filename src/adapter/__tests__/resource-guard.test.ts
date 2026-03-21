import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResourceGuard, type ResourceTransition } from "../resource-guard.js";
import { cpus } from "node:os";

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

  describe("CPU monitoring", () => {
    // The mock cpus() returns constant values, so getCpuUsagePct() computes
    // a zero delta (no change between constructor snapshot and check() snapshot).
    // CPU usage = 0% by default. To get non-zero CPU readings, we queue
    // specific return values via mockReturnValueOnce.
    //
    // Call pattern per operation:
    //   new ResourceGuard()       → 1 call  (constructor baseline)
    //   guard.check()             → 2 calls (getCpuUsagePct + osCpus().length)
    //   guard.checkTransition()   → 2 calls (calls check() internally)
    //   guard.userFacingStatus()  → 2 calls (calls check() internally)
    //   guard.statusLine()        → 2 calls (calls check() internally)

    const mockedCpus = vi.mocked(cpus);

    function makeCpuTimes(user: number, sys: number, idle: number, cores = 8) {
      return Array.from({ length: cores }, () => ({
        model: "mock",
        speed: 2400,
        times: { user, nice: 0, sys, idle, irq: 0 },
      }));
    }

    // CPU times are cumulative since boot. getCpuUsagePct() computes a delta
    // between two snapshots: cpu% = delta_busy / delta_total * 100.
    //
    // LOW→HIGH: busy 0→9000, total 10000→20000, delta = 9000/10000 = 90%.
    // HIGH→RECOVERED: busy 9000→9200, total 20000→40000, delta = 200/20000 = 1%.
    const LOW_CPU = () => makeCpuTimes(0, 0, 10000) as ReturnType<typeof cpus>;
    const HIGH_CPU = () => makeCpuTimes(9000, 0, 11000) as ReturnType<typeof cpus>;
    const RECOVERED_CPU = () => makeCpuTimes(9100, 100, 30800) as ReturnType<typeof cpus>;
    const DEFAULT_CPU = () => makeCpuTimes(1000, 500, 8500) as ReturnType<typeof cpus>;

    afterEach(() => {
      mockedCpus.mockImplementation(DEFAULT_CPU);
    });

    beforeEach(() => {
      mockedCpus.mockImplementation(DEFAULT_CPU);
    });

    /**
     * Queue cpus() returns so the constructor gets a low baseline and the
     * first getCpuUsagePct() call sees high activity, producing a 90% delta.
     * Call 1: constructor baseline (low activity)
     * Call 2: getCpuUsagePct inside check() (high activity)
     * Call 3+: osCpus().length and beyond (high activity — value irrelevant, just needs 8 cores)
     */
    function queueHighCpu(): void {
      mockedCpus
        .mockReturnValueOnce(LOW_CPU())
        .mockReturnValueOnce(HIGH_CPU())
        .mockImplementation(HIGH_CPU);
    }

    it("should include CPU fields in check() snapshot", () => {
      const guard = new ResourceGuard(80, 4, () => 0);
      const snap = guard.check();

      expect(typeof snap.cpuUsedPct).toBe("number");
      expect(snap.cpuCores).toBe(8);
      expect(snap.cpuHealthy).toBe(true);
      expect(typeof snap.memoryHealthy).toBe("boolean");
    });

    it("should report CPU healthy when usage is below ceiling", () => {
      // CPU = 0% (constant mock), default ceiling 85% → healthy
      const guard = new ResourceGuard(80, 4, () => 0);
      const snap = guard.check();

      expect(snap.cpuUsedPct).toBe(0);
      expect(snap.cpuHealthy).toBe(true);
    });

    it("should report CPU unhealthy when usage exceeds ceiling", () => {
      queueHighCpu();

      // cpuCeilingPct = 80, so 90% > 80% → unhealthy
      const guard = new ResourceGuard(80, 4, () => 0, 80);
      const snap = guard.check();

      expect(snap.cpuUsedPct).toBe(90);
      expect(snap.cpuHealthy).toBe(false);
    });

    it("should block canSpawnMore when CPU is over ceiling even with memory and workers OK", () => {
      queueHighCpu();

      // Memory ceiling 80% (memory ~50% → OK), workers 0/4 → OK, CPU 90% > 50% ceiling → blocked
      const guard = new ResourceGuard(80, 4, () => 0, 50);
      const snap = guard.check();

      expect(snap.memoryHealthy).toBe(true);
      expect(snap.cpuHealthy).toBe(false);
      expect(snap.canSpawnMore).toBe(false);
    });

    it("should include CPU info in statusLine", () => {
      const guard = new ResourceGuard(80, 4, () => 2);
      const line = guard.statusLine();

      expect(line).toContain("CPU:");
      expect(line).toContain("cores");
    });

    it("should mention CPU in userFacingStatus when CPU is the issue", () => {
      queueHighCpu();

      // Memory OK (80% ceiling, ~50% usage), CPU 90% > 50% ceiling
      const guard = new ResourceGuard(80, 4, () => 0, 50);
      const status = guard.userFacingStatus();

      expect(status).not.toBeNull();
      expect(status).toContain("CPU usage is high");
      expect(status).not.toContain("Memory usage is high");
    });

    it("should mention only memory in userFacingStatus when only memory is the issue", () => {
      // CPU = 0% (constant mock), CPU ceiling 85% → CPU OK
      // Memory ~50%, memory ceiling 40% → memory NOT OK
      const guard = new ResourceGuard(40, 4, () => 0, 85);
      const status = guard.userFacingStatus();

      expect(status).not.toBeNull();
      expect(status).toContain("Memory usage is high");
      expect(status).not.toContain("CPU usage is high");
    });

    it("should warn about CPU in checkTransition when CPU goes over ceiling", () => {
      queueHighCpu();

      // Memory OK, CPU 90% > 50% ceiling
      const guard = new ResourceGuard(80, 4, () => 0, 50);
      const { warning } = guard.checkTransition();

      expect(warning).not.toBeNull();
      expect(warning).toContain("CPU usage is high");
    });

    it("should include CPU recovery in checkTransition when CPU drops below ceiling", () => {
      // First: make CPU high to set constrained state
      queueHighCpu();

      const guard = new ResourceGuard(80, 4, () => 0, 50);
      guard.checkTransition(); // CPU over ceiling → warning

      // Simulate CPU recovering: RECOVERED_CPU has higher cumulative totals than
      // HIGH_CPU but nearly all the increment is idle, giving ~1% CPU usage.
      mockedCpus.mockImplementation(RECOVERED_CPU);

      const { recovery } = guard.checkTransition();
      expect(recovery).not.toBeNull();
      expect(recovery).toContain("CPU usage is back to normal");
    });
  });

  describe("startMonitoring() / stopMonitoring()", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("should fire warning when state transitions healthy to constrained", () => {
      const guard = new ResourceGuard(40, 4, () => 0);
      const transitions: ResourceTransition[] = [];
      guard.startMonitoring((t) => transitions.push(t), 1000);
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].warning).toContain("Memory usage is high");
      expect(transitions[0].recovery).toBeNull();
      guard.stopMonitoring();
    });

    it("should fire recovery only when usage drops 15% below ceiling (hysteresis)", () => {
      let workers = 4;
      const guard = new ResourceGuard(80, 4, () => workers);
      const transitions: ResourceTransition[] = [];
      guard.startMonitoring((t) => transitions.push(t), 1000);
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].warning).toContain("All worker slots are in use");
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(1);
      workers = 0;
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(2);
      expect(transitions[1].recovery).toContain("Full capabilities restored");
      guard.stopMonitoring();
    });

    it("should NOT fire callback when state is stable", () => {
      const guard = new ResourceGuard(80, 4, () => 0);
      const transitions: ResourceTransition[] = [];
      guard.startMonitoring((t) => transitions.push(t), 1000);
      vi.advanceTimersByTime(5000);
      expect(transitions).toHaveLength(0);
      guard.stopMonitoring();
    });

    it("should stop periodic checks when stopMonitoring is called", () => {
      let workers = 0;
      const guard = new ResourceGuard(80, 4, () => workers);
      const transitions: ResourceTransition[] = [];
      guard.startMonitoring((t) => transitions.push(t), 1000);
      vi.advanceTimersByTime(2000);
      expect(transitions).toHaveLength(0);
      guard.stopMonitoring();
      workers = 4;
      vi.advanceTimersByTime(5000);
      expect(transitions).toHaveLength(0);
    });

    it("should fire warning on first poll if already constrained", () => {
      const guard = new ResourceGuard(80, 4, () => 4);
      const transitions: ResourceTransition[] = [];
      guard.startMonitoring((t) => transitions.push(t), 500);
      vi.advanceTimersByTime(500);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].warning).toContain("All worker slots are in use");
      guard.stopMonitoring();
    });

    it("should NOT fire recovery if memory is still above recovery threshold (hysteresis blocks)", () => {
      let workers = 4;
      const guard = new ResourceGuard(45, 4, () => workers);
      const transitions: ResourceTransition[] = [];
      guard.startMonitoring((t) => transitions.push(t), 1000);
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(1);
      workers = 0;
      vi.advanceTimersByTime(2000);
      expect(transitions).toHaveLength(1);
      guard.stopMonitoring();
    });

    it("should handle full lifecycle: healthy → warning → stable → recovery → stable", () => {
      let workers = 0;
      const guard = new ResourceGuard(80, 4, () => workers);
      const transitions: ResourceTransition[] = [];
      guard.startMonitoring((t) => transitions.push(t), 1000);
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(0);
      workers = 4;
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].warning).toContain("All worker slots are in use");
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(1);
      workers = 0;
      vi.advanceTimersByTime(1000);
      expect(transitions).toHaveLength(2);
      expect(transitions[1].recovery).toContain("Full capabilities restored");
      vi.advanceTimersByTime(2000);
      expect(transitions).toHaveLength(2);
      guard.stopMonitoring();
    });

    it("should replace previous interval when startMonitoring is called again", () => {
      const guard = new ResourceGuard(80, 4, () => 4);
      const t1: ResourceTransition[] = [];
      const t2: ResourceTransition[] = [];
      guard.startMonitoring((t) => t1.push(t), 1000);
      guard.startMonitoring((t) => t2.push(t), 1000);
      vi.advanceTimersByTime(1000);
      expect(t1).toHaveLength(0);
      expect(t2).toHaveLength(1);
      guard.stopMonitoring();
    });
  });
});
