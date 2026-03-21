import { freemem, totalmem, platform, cpus as osCpus } from "node:os";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ResourceSnapshot {
  memoryUsedPct: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryAvailableMb: number;
  cpuUsedPct: number;
  cpuCores: number;
  activeWorkers: number;
  maxWorkers: number;
  canSpawnMore: boolean;
  healthy: boolean;
  memoryHealthy: boolean;
  cpuHealthy: boolean;
  platform: string;
}

/**
 * Calculate CPU usage % by comparing two os.cpus() snapshots.
 * Returns the aggregate usage across all cores (0-100).
 *
 * Works on macOS, Linux, and Windows — os.cpus() is cross-platform.
 * On the first call (no previous snapshot), returns 0 since we need
 * two data points to compute a delta.
 */
interface CpuTimes { user: number; nice: number; sys: number; idle: number; irq: number }

function sumCpuTimes(cores: { times: CpuTimes }[]): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const core of cores) {
    const t = core.times;
    const coreBusy = t.user + t.nice + t.sys + t.irq;
    const coreTotal = coreBusy + t.idle;
    busy += coreBusy;
    total += coreTotal;
  }
  return { busy, total };
}

/**
 * Get the actual available memory in bytes, accounting for OS differences.
 *
 * - macOS: os.freemem() only reports "free" pages, excluding inactive and
 *   purgeable pages that are immediately reclaimable. This makes memory look
 *   90%+ used even when gigabytes are available. We use vm_stat to compute
 *   free + inactive + purgeable — matching what Activity Monitor shows.
 * - Linux: os.freemem() returns MemFree which excludes buffers/cache.
 *   We read MemAvailable from /proc/meminfo for the real number.
 * - Windows: os.freemem() returns actual available memory. Works correctly.
 */
function getAvailableMemoryBytes(): number {
  if (platform() === "darwin") {
    try {
      const vmstat = execSync("vm_stat", { encoding: "utf-8", timeout: 2000 });
      // vm_stat reports in pages; page size is on the first line
      const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

      const getPages = (label: string): number => {
        const match = vmstat.match(new RegExp(`${label}:\\s+(\\d+)`));
        return match ? parseInt(match[1], 10) : 0;
      };

      const free = getPages("Pages free");
      const inactive = getPages("Pages inactive");
      const purgeable = getPages("Pages purgeable");

      return (free + inactive + purgeable) * pageSize;
    } catch {
      // Fallback to os.freemem() if vm_stat fails
      return freemem();
    }
  }

  if (platform() === "linux") {
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf-8");
      const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (match) {
        return parseInt(match[1], 10) * 1024; // kB → bytes
      }
    } catch {
      // Fallback to os.freemem() if /proc/meminfo is unavailable
    }
  }

  // Windows: os.freemem() reports actual available memory correctly.
  // Also used as fallback for any unrecognized platform.
  return freemem();
}

export interface ResourceTransition {
  warning: string | null;
  recovery: string | null;
}

/** Hysteresis margin: recovery fires when usage drops this many % below the ceiling. */
const RECOVERY_HYSTERESIS_PCT = 15;

/**
 * Checks system resources before processing a message.
 * Tracks state transitions to detect when constraints start or resolve.
 */
export class ResourceGuard {
  private memoryCeilingPct: number;
  private cpuCeilingPct: number;
  private maxWorkers: number;
  private getActiveWorkerCount: () => number;
  private prevMemoryOver = false;
  private prevCpuOver = false;
  private prevWorkersOver = false;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private wasConstrained = false;
  private prevCpuSnapshot: { busy: number; total: number } | null = null;

  constructor(
    memoryCeilingPct: number = 80,
    maxWorkers: number = 4,
    getActiveWorkerCount: () => number = () => 0,
    cpuCeilingPct: number = 85,
  ) {
    this.memoryCeilingPct = memoryCeilingPct;
    this.cpuCeilingPct = cpuCeilingPct;
    this.maxWorkers = maxWorkers;
    this.getActiveWorkerCount = getActiveWorkerCount;
    // Take initial CPU snapshot so the first check() has a baseline
    this.prevCpuSnapshot = sumCpuTimes(osCpus());
  }

  private getCpuUsagePct(): number {
    const current = sumCpuTimes(osCpus());
    if (!this.prevCpuSnapshot) {
      this.prevCpuSnapshot = current;
      return 0;
    }
    const busyDelta = current.busy - this.prevCpuSnapshot.busy;
    const totalDelta = current.total - this.prevCpuSnapshot.total;
    this.prevCpuSnapshot = current;
    if (totalDelta === 0) return 0;
    return Math.round((busyDelta / totalDelta) * 100);
  }

  /**
   * Start a periodic resource monitor that checks every `intervalMs`.
   *
   * Uses hysteresis to avoid oscillation: recovery only fires when memory
   * drops 15% below the ceiling (e.g., ceiling 92% → recovery at 77%).
   * This prevents rapid warn/recover cycles when usage hovers near the limit.
   *
   * The callback receives a `ResourceTransition` only when state changes.
   * It is NOT called on every poll — only on transitions.
   */
  startMonitoring(
    callback: (transition: ResourceTransition) => void,
    intervalMs: number = 30_000,
  ): void {
    this.stopMonitoring();
    this.monitorTimer = setInterval(() => {
      const transition = this.checkTransitionWithHysteresis();
      if (transition.warning || transition.recovery) {
        callback(transition);
      }
    }, intervalMs);
  }

  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  /**
   * Like checkTransition() but uses hysteresis for recovery.
   * Warning fires at the ceiling. Recovery fires 15% below the ceiling.
   * This prevents oscillation when usage hovers near the threshold.
   */
  private checkTransitionWithHysteresis(): ResourceTransition {
    const snap = this.check();
    const memoryOver = !snap.memoryHealthy;
    const cpuOver = !snap.cpuHealthy;
    const workersOver = snap.activeWorkers >= snap.maxWorkers;
    const isConstrained = memoryOver || cpuOver || workersOver;

    // Recovery thresholds: must drop RECOVERY_HYSTERESIS_PCT below ceilings
    const memRecoveryThreshold = this.memoryCeilingPct - RECOVERY_HYSTERESIS_PCT;
    const cpuRecoveryThreshold = this.cpuCeilingPct - RECOVERY_HYSTERESIS_PCT;
    const memoryWellBelow = snap.memoryUsedPct < memRecoveryThreshold;
    const cpuWellBelow = snap.cpuUsedPct < cpuRecoveryThreshold;
    const workersRecovered = snap.activeWorkers < snap.maxWorkers;

    let warning: string | null = null;
    let recovery: string | null = null;

    // Entering constrained state
    if (isConstrained && !this.wasConstrained) {
      const parts: string[] = [];
      if (memoryOver) parts.push(`Memory usage is high (at ${snap.memoryUsedPct}%).`);
      if (cpuOver) parts.push(`CPU usage is high (at ${snap.cpuUsedPct}%).`);
      if (workersOver) parts.push("All worker slots are in use.");
      parts.push("Worker spawning is paused — I can still chat, but won't be able to run parallel build tasks until resources free up.");
      warning = parts.join(" ");
      this.wasConstrained = true;
    }

    // Recovery: all resources must be well below their thresholds (hysteresis)
    if (this.wasConstrained && memoryWellBelow && cpuWellBelow && workersRecovered) {
      const parts: string[] = [];
      if (this.prevMemoryOver) parts.push(`Memory usage has dropped to ${snap.memoryUsedPct}% — well below the ${this.memoryCeilingPct}% threshold.`);
      if (this.prevCpuOver) parts.push(`CPU usage has dropped to ${snap.cpuUsedPct}% — well below the ${this.cpuCeilingPct}% threshold.`);
      if (this.prevWorkersOver) parts.push("Worker slots are available again.");
      parts.push("Full capabilities restored — ready to resume work.");
      recovery = parts.join(" ");
      this.wasConstrained = false;
    }

    this.prevMemoryOver = memoryOver;
    this.prevCpuOver = cpuOver;
    this.prevWorkersOver = workersOver;

    return { warning, recovery };
  }

  check(): ResourceSnapshot {
    const totalBytes = totalmem();
    const availableBytes = getAvailableMemoryBytes();
    const usedBytes = totalBytes - availableBytes;
    const totalMb = totalBytes / (1024 * 1024);
    const usedMb = usedBytes / (1024 * 1024);
    const availableMb = availableBytes / (1024 * 1024);
    const usedPct = (usedBytes / totalBytes) * 100;
    const cpuUsedPct = this.getCpuUsagePct();
    const activeWorkers = this.getActiveWorkerCount();
    const memoryOk = usedPct < this.memoryCeilingPct;
    const cpuOk = cpuUsedPct < this.cpuCeilingPct;
    const workersOk = activeWorkers < this.maxWorkers;

    return {
      memoryUsedPct: Math.round(usedPct),
      memoryUsedMb: Math.round(usedMb),
      memoryTotalMb: Math.round(totalMb),
      memoryAvailableMb: Math.round(availableMb),
      cpuUsedPct,
      cpuCores: osCpus().length,
      activeWorkers,
      maxWorkers: this.maxWorkers,
      canSpawnMore: memoryOk && cpuOk && workersOk,
      healthy: memoryOk && cpuOk,
      memoryHealthy: memoryOk,
      cpuHealthy: cpuOk,
      platform: platform(),
    };
  }

  /**
   * Returns a human-readable status string for injection into Claude's context.
   * Technical details included — this is for the system prompt, not user-facing.
   */
  statusLine(): string {
    const snap = this.check();
    const memLine = `Memory: ${snap.memoryUsedMb}MB / ${snap.memoryTotalMb}MB (${snap.memoryUsedPct}%, ${snap.memoryAvailableMb}MB available)${snap.memoryHealthy ? "" : " [OVER LIMIT]"}`;
    const cpuLine = `CPU: ${snap.cpuUsedPct}% (${snap.cpuCores} cores)${snap.cpuHealthy ? "" : " [OVER LIMIT]"}`;
    const workerLine = `Workers: ${snap.activeWorkers}/${snap.maxWorkers}${snap.canSpawnMore ? "" : " [AT CAPACITY]"}`;
    return `${memLine} | ${cpuLine} | ${workerLine}`;
  }

  /**
   * Returns a plain-language status for Discord users.
   * Returns null when resources are healthy — no message needed.
   * Specific: mentions memory only if memory is the issue, workers only if workers are the issue.
   */
  userFacingStatus(): string | null {
    const snap = this.check();
    const memoryOver = !snap.memoryHealthy;
    const cpuOver = !snap.cpuHealthy;
    const workersOver = snap.activeWorkers >= snap.maxWorkers;
    if (!memoryOver && !cpuOver && !workersOver) return null;

    const parts: string[] = [];

    if (memoryOver) {
      parts.push(`Memory usage is high (at ${snap.memoryUsedPct}%).`);
    }

    if (cpuOver) {
      parts.push(`CPU usage is high (at ${snap.cpuUsedPct}%).`);
    }

    if (workersOver) {
      parts.push("All worker slots are in use.");
    }

    parts.push(
      "Worker spawning is paused — I can still chat, but won't be able to run parallel build tasks until resources free up."
    );

    return parts.join(" ");
  }

  /**
   * Check resource state and detect transitions.
   * Returns a warning when resources become constrained, or a recovery
   * message when they free up. Returns both null when state hasn't changed.
   *
   * Call this on every message to track state changes over time.
   */
  checkTransition(): ResourceTransition {
    const snap = this.check();
    const memoryOver = !snap.memoryHealthy;
    const cpuOver = !snap.cpuHealthy;
    const workersOver = snap.activeWorkers >= snap.maxWorkers;

    let warning: string | null = null;
    let recovery: string | null = null;

    // Detect newly constrained resources
    const newConstraints: string[] = [];
    if (memoryOver && !this.prevMemoryOver) {
      newConstraints.push(`Memory usage is high (at ${snap.memoryUsedPct}%).`);
    }
    if (cpuOver && !this.prevCpuOver) {
      newConstraints.push(`CPU usage is high (at ${snap.cpuUsedPct}%).`);
    }
    if (workersOver && !this.prevWorkersOver) {
      newConstraints.push("All worker slots are in use.");
    }
    if (newConstraints.length > 0) {
      newConstraints.push(
        "Worker spawning is paused — I can still chat, but won't be able to run parallel build tasks until resources free up."
      );
      warning = newConstraints.join(" ");
    }

    // Detect recovery
    const recovered: string[] = [];
    if (!memoryOver && this.prevMemoryOver) {
      recovered.push("Memory usage is back to normal.");
    }
    if (!cpuOver && this.prevCpuOver) {
      recovered.push("CPU usage is back to normal.");
    }
    if (!workersOver && this.prevWorkersOver) {
      recovered.push("Worker slots are available again.");
    }
    if (recovered.length > 0) {
      recovered.push("Full capabilities restored.");
      recovery = recovered.join(" ");
    }

    // Update state
    this.prevMemoryOver = memoryOver;
    this.prevCpuOver = cpuOver;
    this.prevWorkersOver = workersOver;

    return { warning, recovery };
  }
}
