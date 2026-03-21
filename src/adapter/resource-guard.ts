import { freemem, totalmem, platform } from "node:os";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ResourceSnapshot {
  memoryUsedPct: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryAvailableMb: number;
  activeWorkers: number;
  maxWorkers: number;
  canSpawnMore: boolean;
  healthy: boolean;
  platform: string;
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
  private maxWorkers: number;
  private getActiveWorkerCount: () => number;
  private prevMemoryOver = false;
  private prevWorkersOver = false;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private wasConstrained = false;

  constructor(
    memoryCeilingPct: number = 80,
    maxWorkers: number = 4,
    getActiveWorkerCount: () => number = () => 0,
  ) {
    this.memoryCeilingPct = memoryCeilingPct;
    this.maxWorkers = maxWorkers;
    this.getActiveWorkerCount = getActiveWorkerCount;
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
    const memoryOver = !snap.healthy;
    const workersOver = snap.activeWorkers >= snap.maxWorkers;
    const isConstrained = memoryOver || workersOver;

    // Recovery threshold: memory must drop RECOVERY_HYSTERESIS_PCT below the ceiling
    const recoveryThreshold = this.memoryCeilingPct - RECOVERY_HYSTERESIS_PCT;
    const memoryWellBelow = snap.memoryUsedPct < recoveryThreshold;
    const workersRecovered = snap.activeWorkers < snap.maxWorkers;

    let warning: string | null = null;
    let recovery: string | null = null;

    // Entering constrained state
    if (isConstrained && !this.wasConstrained) {
      const parts: string[] = [];
      if (memoryOver) parts.push(`Memory usage is high (at ${snap.memoryUsedPct}%).`);
      if (workersOver) parts.push("All worker slots are in use.");
      parts.push("Worker spawning is paused — I can still chat, but won't be able to run parallel build tasks until resources free up.");
      warning = parts.join(" ");
      this.wasConstrained = true;
    }

    // Recovery: only when usage drops well below threshold (hysteresis)
    if (this.wasConstrained && memoryWellBelow && workersRecovered) {
      const parts: string[] = [];
      if (this.prevMemoryOver) parts.push(`Memory usage has dropped to ${snap.memoryUsedPct}% — well below the ${this.memoryCeilingPct}% threshold.`);
      if (this.prevWorkersOver) parts.push("Worker slots are available again.");
      parts.push("Full capabilities restored — ready to resume work.");
      recovery = parts.join(" ");
      this.wasConstrained = false;
    }

    this.prevMemoryOver = memoryOver;
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
    const activeWorkers = this.getActiveWorkerCount();
    const memoryOk = usedPct < this.memoryCeilingPct;
    const workersOk = activeWorkers < this.maxWorkers;

    return {
      memoryUsedPct: Math.round(usedPct),
      memoryUsedMb: Math.round(usedMb),
      memoryTotalMb: Math.round(totalMb),
      memoryAvailableMb: Math.round(availableMb),
      activeWorkers,
      maxWorkers: this.maxWorkers,
      canSpawnMore: memoryOk && workersOk,
      healthy: memoryOk,
      platform: platform(),
    };
  }

  /**
   * Returns a human-readable status string for injection into Claude's context.
   * Technical details included — this is for the system prompt, not user-facing.
   */
  statusLine(): string {
    const snap = this.check();
    const memLine = `Memory: ${snap.memoryUsedMb}MB / ${snap.memoryTotalMb}MB (${snap.memoryUsedPct}%, ${snap.memoryAvailableMb}MB available)${snap.healthy ? "" : " [OVER LIMIT]"}`;
    const workerLine = `Workers: ${snap.activeWorkers}/${snap.maxWorkers}${snap.canSpawnMore ? "" : " [AT CAPACITY]"}`;
    return `${memLine} | ${workerLine}`;
  }

  /**
   * Returns a plain-language status for Discord users.
   * Returns null when resources are healthy — no message needed.
   * Specific: mentions memory only if memory is the issue, workers only if workers are the issue.
   */
  userFacingStatus(): string | null {
    const snap = this.check();
    const memoryOver = !snap.healthy;
    const workersOver = snap.activeWorkers >= snap.maxWorkers;
    if (!memoryOver && !workersOver) return null;

    const parts: string[] = [];

    if (memoryOver) {
      parts.push(`Memory usage is high (at ${snap.memoryUsedPct}%).`);
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
    const memoryOver = !snap.healthy;
    const workersOver = snap.activeWorkers >= snap.maxWorkers;

    let warning: string | null = null;
    let recovery: string | null = null;

    // Detect newly constrained resources
    const newConstraints: string[] = [];
    if (memoryOver && !this.prevMemoryOver) {
      newConstraints.push(`Memory usage is high (at ${snap.memoryUsedPct}%).`);
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
    if (!workersOver && this.prevWorkersOver) {
      recovered.push("Worker slots are available again.");
    }
    if (recovered.length > 0) {
      recovered.push("Full capabilities restored.");
      recovery = recovered.join(" ");
    }

    // Update state
    this.prevMemoryOver = memoryOver;
    this.prevWorkersOver = workersOver;

    return { warning, recovery };
  }
}
