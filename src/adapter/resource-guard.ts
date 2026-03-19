import { freemem, totalmem, platform } from "node:os";
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
 * - macOS: os.freemem() excludes inactive/cached pages, making memory look
 *   much more used than it is. We use a higher ceiling (85%) to compensate.
 * - Linux: os.freemem() returns MemFree which excludes buffers/cache.
 *   We read MemAvailable from /proc/meminfo for the real number.
 * - Windows: os.freemem() returns actual available memory. Works correctly.
 */
function getAvailableMemoryBytes(): number {
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
  // macOS and Windows: use os.freemem()
  // macOS compensates via higher default ceiling (85%)
  // Windows reports available memory correctly
  return freemem();
}

/**
 * Checks system resources before processing a message.
 * Refuses to start new work when memory exceeds the ceiling or workers are at capacity.
 */
export class ResourceGuard {
  private memoryCeilingPct: number;
  private maxWorkers: number;
  private getActiveWorkerCount: () => number;

  constructor(
    memoryCeilingPct: number = 80,
    maxWorkers: number = 4,
    getActiveWorkerCount: () => number = () => 0,
  ) {
    this.memoryCeilingPct = memoryCeilingPct;
    this.maxWorkers = maxWorkers;
    this.getActiveWorkerCount = getActiveWorkerCount;
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
   */
  statusLine(): string {
    const snap = this.check();
    const memLine = `Memory: ${snap.memoryUsedMb}MB / ${snap.memoryTotalMb}MB (${snap.memoryUsedPct}%, ${snap.memoryAvailableMb}MB available)${snap.healthy ? "" : " [OVER LIMIT]"}`;
    const workerLine = `Workers: ${snap.activeWorkers}/${snap.maxWorkers}${snap.canSpawnMore ? "" : " [AT CAPACITY]"}`;
    return `${memLine} | ${workerLine}`;
  }
}
