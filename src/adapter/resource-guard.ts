import { freemem, totalmem } from "node:os";

export interface ResourceSnapshot {
  memoryUsedPct: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  activeWorkers: number;
  maxWorkers: number;
  canSpawnMore: boolean;
  healthy: boolean;
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
    const totalMb = totalmem() / (1024 * 1024);
    const freeMb = freemem() / (1024 * 1024);
    const usedMb = totalMb - freeMb;
    const usedPct = (usedMb / totalMb) * 100;
    const activeWorkers = this.getActiveWorkerCount();
    const memoryOk = usedPct < this.memoryCeilingPct;
    const workersOk = activeWorkers < this.maxWorkers;

    return {
      memoryUsedPct: Math.round(usedPct),
      memoryUsedMb: Math.round(usedMb),
      memoryTotalMb: Math.round(totalMb),
      activeWorkers,
      maxWorkers: this.maxWorkers,
      canSpawnMore: memoryOk && workersOk,
      healthy: memoryOk,
    };
  }

  /**
   * Returns a human-readable status string for injection into Claude's context.
   */
  statusLine(): string {
    const snap = this.check();
    const memLine = `Memory: ${snap.memoryUsedMb}MB / ${snap.memoryTotalMb}MB (${snap.memoryUsedPct}%)${snap.healthy ? "" : " [OVER LIMIT]"}`;
    const workerLine = `Workers: ${snap.activeWorkers}/${snap.maxWorkers}${snap.canSpawnMore ? "" : " [AT CAPACITY]"}`;
    return `${memLine} | ${workerLine}`;
  }
}
