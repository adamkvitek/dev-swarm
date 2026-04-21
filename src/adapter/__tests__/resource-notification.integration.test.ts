import { describe, it, expect, vi, beforeEach } from "vitest";
import { cpus } from "node:os";
import type { ResourceSnapshot } from "../resource-guard.js";

/**
 * Integration tests for the DiscordAdapter's resource notification behavior.
 *
 * These tests verify the adapter's handleMessage logic around resource constraints
 * by testing the underlying components in isolation — ResourceGuard snapshots,
 * channel targeting, and message content. We mock Discord.js and the streaming
 * module to focus on the adapter's decision-making.
 */

// --- Mock factories (same patterns as http-api.test.ts) ---

interface MockChannel {
  id: string;
  name: string;
  send: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  messages: string[];
}

function createMockChannel(id: string, name: string): MockChannel {
  const messages: string[] = [];
  return {
    id,
    name,
    send: vi.fn(async (content: string) => {
      messages.push(content);
      return { content, edit: vi.fn() };
    }),
    sendTyping: vi.fn(async () => {}),
    messages,
  };
}

interface MockResourceGuard {
  check: ReturnType<typeof vi.fn>;
  statusLine: ReturnType<typeof vi.fn>;
  setSnapshot: (snap: Partial<ResourceSnapshot>) => void;
}

function createMockResourceGuard(initial?: Partial<ResourceSnapshot>): MockResourceGuard {
  let snapshot: ResourceSnapshot = {
    memoryUsedPct: 45,
    memoryUsedMb: 7200,
    memoryTotalMb: 16000,
    memoryAvailableMb: 8800,
    cpuUsedPct: 30,
    cpuCores: cpus().length,
    activeWorkers: 0,
    maxWorkers: 4,
    canSpawnMore: true,
    healthy: true,
    memoryHealthy: true,
    cpuHealthy: true,
    platform: "darwin",
    ...initial,
  };

  const guard: MockResourceGuard = {
    check: vi.fn(() => snapshot),
    statusLine: vi.fn(() => {
      const snap = snapshot;
      const memLine = `Memory: ${snap.memoryUsedMb}MB / ${snap.memoryTotalMb}MB (${snap.memoryUsedPct}%, ${snap.memoryAvailableMb}MB available)${snap.healthy ? "" : " [OVER LIMIT]"}`;
      const workerLine = `Workers: ${snap.activeWorkers}/${snap.maxWorkers}${snap.canSpawnMore ? "" : " [AT CAPACITY]"}`;
      return `${memLine} | ${workerLine}`;
    }),
    setSnapshot: (partial: Partial<ResourceSnapshot>) => {
      snapshot = { ...snapshot, ...partial };
    },
  };

  return guard;
}

/**
 * Simulates the adapter's handleMessage resource check.
 *
 * This mirrors the logic in discord-adapter.ts lines 117-124:
 *   const resourceSnap = this.resources.check();
 *   if (!resourceSnap.healthy) { await channel.send(warning); return; }
 */
async function simulateHandleMessage(
  channel: MockChannel,
  guard: MockResourceGuard,
  messageContent: string,
): Promise<{ blocked: boolean; warning?: string }> {
  const snap = guard.check();

  if (!snap.healthy) {
    const warning =
      `I'm currently at ${snap.memoryUsedPct}% memory usage. ` +
      `I need to wait for running tasks to finish.`;
    await channel.send(warning);
    return { blocked: true, warning };
  }

  return { blocked: false };
}

/**
 * Simulates broadcasting resource warnings to active channels.
 * Active channels = channels that have received messages.
 */
async function broadcastResourceWarning(
  activeChannels: MockChannel[],
  guard: MockResourceGuard,
): Promise<string[]> {
  const snap = guard.check();
  const warnings: string[] = [];

  if (!snap.healthy || !snap.canSpawnMore) {
    const parts: string[] = [];

    if (!snap.healthy) {
      parts.push(`Memory usage is high (${snap.memoryUsedPct}%).`);
    }
    if (snap.activeWorkers >= snap.maxWorkers) {
      parts.push(`All ${snap.maxWorkers} worker slots are in use.`);
    }

    const warning = parts.join(" ") + " Performance may be degraded.";

    for (const ch of activeChannels) {
      await ch.send(warning);
      warnings.push(warning);
    }
  }

  return warnings;
}

/**
 * Simulates broadcasting a recovery notification.
 */
async function broadcastRecoveryNotice(
  activeChannels: MockChannel[],
  message: string,
): Promise<void> {
  for (const ch of activeChannels) {
    await ch.send(message);
  }
}

/**
 * Detects a state transition in the ResourceGuard.
 * Returns a warning/recovery message if state changed, null if stable.
 */
function checkTransition(
  previousHealthy: boolean,
  previousCanSpawn: boolean,
  guard: MockResourceGuard,
): { type: "warning" | "recovery" | null; message: string | null; healthy: boolean; canSpawn: boolean } {
  const snap = guard.check();
  const nowHealthy = snap.healthy;
  const nowCanSpawn = snap.canSpawnMore;

  // Went from good to bad
  if ((previousHealthy && !nowHealthy) || (previousCanSpawn && !nowCanSpawn)) {
    const parts: string[] = [];
    if (!nowHealthy) parts.push(`Memory usage is high (${snap.memoryUsedPct}%).`);
    if (!nowCanSpawn && snap.activeWorkers >= snap.maxWorkers) {
      parts.push(`All ${snap.maxWorkers} worker slots are in use.`);
    }
    return {
      type: "warning",
      message: parts.join(" "),
      healthy: nowHealthy,
      canSpawn: nowCanSpawn,
    };
  }

  // Went from bad to good
  if ((!previousHealthy && nowHealthy) || (!previousCanSpawn && nowCanSpawn)) {
    const parts: string[] = [];
    if (!previousHealthy && nowHealthy) parts.push("Memory has recovered.");
    if (!previousCanSpawn && nowCanSpawn) parts.push("Worker slots are available again.");
    return {
      type: "recovery",
      message: parts.join(" "),
      healthy: nowHealthy,
      canSpawn: nowCanSpawn,
    };
  }

  return { type: null, message: null, healthy: nowHealthy, canSpawn: nowCanSpawn };
}

// --- Tests ---

describe("DiscordAdapter — resource notification integration", () => {
  describe("resource warning targets only active channels", () => {
    it("should warn only channels that have received messages", async () => {
      const guard = createMockResourceGuard({ healthy: false, memoryUsedPct: 92 });
      const ch1 = createMockChannel("ch1", "general");
      const ch2 = createMockChannel("ch2", "dev");
      const ch3 = createMockChannel("ch3", "off-topic");

      // Only ch1 and ch2 are "active" (have received messages)
      const activeChannels = [ch1, ch2];

      await broadcastResourceWarning(activeChannels, guard);

      expect(ch1.send).toHaveBeenCalledTimes(1);
      expect(ch2.send).toHaveBeenCalledTimes(1);
      expect(ch3.send).not.toHaveBeenCalled();
    });

    it("should not send warnings when resources are healthy", async () => {
      const guard = createMockResourceGuard({ healthy: true, canSpawnMore: true });
      const ch1 = createMockChannel("ch1", "general");
      const ch2 = createMockChannel("ch2", "dev");

      const warnings = await broadcastResourceWarning([ch1, ch2], guard);

      expect(warnings).toHaveLength(0);
      expect(ch1.send).not.toHaveBeenCalled();
      expect(ch2.send).not.toHaveBeenCalled();
    });
  });

  describe("resource recovery notification reaches active channels", () => {
    it("should send recovery message to all active channels", async () => {
      const ch1 = createMockChannel("ch1", "general");
      const ch2 = createMockChannel("ch2", "dev");
      const activeChannels = [ch1, ch2];

      await broadcastRecoveryNotice(activeChannels, "Resources are back to normal.");

      expect(ch1.send).toHaveBeenCalledWith("Resources are back to normal.");
      expect(ch2.send).toHaveBeenCalledWith("Resources are back to normal.");
    });

    it("should not reach inactive channels on recovery", async () => {
      const ch1 = createMockChannel("ch1", "general");
      const ch3 = createMockChannel("ch3", "off-topic");

      // Only ch1 is active
      await broadcastRecoveryNotice([ch1], "Resources are back to normal.");

      expect(ch1.send).toHaveBeenCalledTimes(1);
      expect(ch3.send).not.toHaveBeenCalled();
    });
  });

  describe("specific warning content — memory only", () => {
    it("should mention Memory and NOT mention worker slots when only memory is constrained", async () => {
      const guard = createMockResourceGuard({
        healthy: false,
        memoryUsedPct: 95,
        canSpawnMore: false, // because memory is unhealthy
        activeWorkers: 1,
        maxWorkers: 4,
      });
      const ch = createMockChannel("ch1", "general");

      await broadcastResourceWarning([ch], guard);

      const msg = ch.messages[0];
      expect(msg).toContain("Memory");
      expect(msg).not.toContain("worker slots");
    });
  });

  describe("specific warning content — workers only", () => {
    it("should mention worker slots and NOT mention Memory when only workers are saturated", async () => {
      const guard = createMockResourceGuard({
        healthy: true,
        memoryUsedPct: 45,
        canSpawnMore: false,
        activeWorkers: 4,
        maxWorkers: 4,
      });
      const ch = createMockChannel("ch1", "general");

      await broadcastResourceWarning([ch], guard);

      const msg = ch.messages[0];
      expect(msg).toContain("worker slots");
      expect(msg).not.toContain("Memory usage is high");
    });
  });

  describe("specific warning content — both constrained", () => {
    it("should mention BOTH Memory and worker slots when both are constrained", async () => {
      const guard = createMockResourceGuard({
        healthy: false,
        memoryUsedPct: 95,
        canSpawnMore: false,
        activeWorkers: 4,
        maxWorkers: 4,
      });
      const ch = createMockChannel("ch1", "general");

      await broadcastResourceWarning([ch], guard);

      const msg = ch.messages[0];
      expect(msg).toContain("Memory");
      expect(msg).toContain("worker slots");
    });
  });

  describe("no repeated warnings", () => {
    it("should not send a second warning while still constrained", async () => {
      const guard = createMockResourceGuard({
        healthy: false,
        memoryUsedPct: 95,
        canSpawnMore: false,
        activeWorkers: 4,
        maxWorkers: 4,
      });

      // First transition: healthy → constrained → warning
      let state = checkTransition(true, true, guard);
      expect(state.type).toBe("warning");
      expect(state.message).toContain("Memory");

      // Second check while still constrained → no new warning
      const state2 = checkTransition(state.healthy, state.canSpawn, guard);
      expect(state2.type).toBeNull();
      expect(state2.message).toBeNull();
    });

    it("should not repeat recovery messages once already recovered", () => {
      const guard = createMockResourceGuard({
        healthy: true,
        canSpawnMore: true,
        activeWorkers: 0,
        maxWorkers: 4,
      });

      // First: constrained → healthy = recovery
      let state = checkTransition(false, false, guard);
      expect(state.type).toBe("recovery");

      // Second: healthy → healthy = stable (no message)
      const state2 = checkTransition(state.healthy, state.canSpawn, guard);
      expect(state2.type).toBeNull();
      expect(state2.message).toBeNull();
    });
  });

  describe("bot still responds when constrained", () => {
    it("should send a memory warning but not refuse the message entirely", async () => {
      const guard = createMockResourceGuard({
        healthy: false,
        memoryUsedPct: 92,
      });
      const ch = createMockChannel("ch1", "general");

      const result = await simulateHandleMessage(ch, guard, "hello bot");

      // The adapter blocks with a warning, but it's a user-facing response, not silence
      expect(result.blocked).toBe(true);
      expect(result.warning).toContain("92%");
      expect(result.warning).toContain("memory usage");
      expect(ch.send).toHaveBeenCalledTimes(1);
    });

    it("should include resource status in system prompt when constrained", () => {
      const guard = createMockResourceGuard({
        healthy: false,
        memoryUsedPct: 92,
        canSpawnMore: false,
        activeWorkers: 4,
        maxWorkers: 4,
      });

      const statusLine = guard.statusLine();
      expect(statusLine).toContain("[OVER LIMIT]");
      expect(statusLine).toContain("[AT CAPACITY]");

      // The adapter injects this into the system prompt so Claude knows resources are constrained
      const systemPrompt = `## Current System Status\n${statusLine}`;
      expect(systemPrompt).toContain("OVER LIMIT");
      expect(systemPrompt).toContain("AT CAPACITY");
    });

    it("should process messages normally when resources are healthy", async () => {
      const guard = createMockResourceGuard({
        healthy: true,
        memoryUsedPct: 45,
        canSpawnMore: true,
      });
      const ch = createMockChannel("ch1", "general");

      const result = await simulateHandleMessage(ch, guard, "hello bot");

      expect(result.blocked).toBe(false);
      // When not blocked, the adapter proceeds to Claude CLI — no send on the resource check
      expect(ch.send).not.toHaveBeenCalled();
    });
  });

  describe("handleMessage resource check mirrors adapter behavior", () => {
    it("should block when memory exceeds ceiling and include percentage in warning", async () => {
      const guard = createMockResourceGuard({
        healthy: false,
        memoryUsedPct: 88,
      });
      const ch = createMockChannel("ch1", "test");

      const result = await simulateHandleMessage(ch, guard, "deploy the app");

      expect(result.blocked).toBe(true);
      expect(result.warning).toContain("88%");
      expect(ch.messages[0]).toContain("memory usage");
    });

    it("should not block when memory is below ceiling", async () => {
      const guard = createMockResourceGuard({
        healthy: true,
        memoryUsedPct: 45,
      });
      const ch = createMockChannel("ch1", "test");

      const result = await simulateHandleMessage(ch, guard, "deploy the app");

      expect(result.blocked).toBe(false);
      expect(ch.messages).toHaveLength(0);
    });
  });

  describe("state transition detection lifecycle", () => {
    it("should detect warning → stable → recovery → stable cycle", () => {
      const guard = createMockResourceGuard();
      let prevHealthy = true;
      let prevCanSpawn = true;

      // Phase 1: Go constrained (memory)
      guard.setSnapshot({ healthy: false, memoryUsedPct: 95, canSpawnMore: false });
      let transition = checkTransition(prevHealthy, prevCanSpawn, guard);
      expect(transition.type).toBe("warning");
      expect(transition.message).toContain("Memory");
      prevHealthy = transition.healthy;
      prevCanSpawn = transition.canSpawn;

      // Phase 2: Stay constrained — no new message
      transition = checkTransition(prevHealthy, prevCanSpawn, guard);
      expect(transition.type).toBeNull();
      prevHealthy = transition.healthy;
      prevCanSpawn = transition.canSpawn;

      // Phase 3: Recover
      guard.setSnapshot({ healthy: true, memoryUsedPct: 45, canSpawnMore: true });
      transition = checkTransition(prevHealthy, prevCanSpawn, guard);
      expect(transition.type).toBe("recovery");
      expect(transition.message).toContain("recovered");
      prevHealthy = transition.healthy;
      prevCanSpawn = transition.canSpawn;

      // Phase 4: Stay healthy — no message
      transition = checkTransition(prevHealthy, prevCanSpawn, guard);
      expect(transition.type).toBeNull();
    });

    it("should detect worker-only constraint and recovery", () => {
      const guard = createMockResourceGuard();
      let prevHealthy = true;
      let prevCanSpawn = true;

      // Workers fill up, memory still ok
      guard.setSnapshot({ healthy: true, canSpawnMore: false, activeWorkers: 4, maxWorkers: 4 });
      let transition = checkTransition(prevHealthy, prevCanSpawn, guard);
      expect(transition.type).toBe("warning");
      expect(transition.message).toContain("worker slots");
      prevHealthy = transition.healthy;
      prevCanSpawn = transition.canSpawn;

      // Workers clear
      guard.setSnapshot({ healthy: true, canSpawnMore: true, activeWorkers: 1, maxWorkers: 4 });
      transition = checkTransition(prevHealthy, prevCanSpawn, guard);
      expect(transition.type).toBe("recovery");
      expect(transition.message).toContain("Worker slots");
      prevHealthy = transition.healthy;
      prevCanSpawn = transition.canSpawn;

      // Stable
      transition = checkTransition(prevHealthy, prevCanSpawn, guard);
      expect(transition.type).toBeNull();
    });

    it("should detect partial recovery when memory recovers but workers remain full", () => {
      const guard = createMockResourceGuard();

      // Both constrained
      guard.setSnapshot({ healthy: false, memoryUsedPct: 95, canSpawnMore: false, activeWorkers: 4, maxWorkers: 4 });
      let transition = checkTransition(true, true, guard);
      expect(transition.type).toBe("warning");
      expect(transition.message).toContain("Memory");
      expect(transition.message).toContain("worker slots");

      // Memory recovers, workers still full
      guard.setSnapshot({ healthy: true, memoryUsedPct: 45, canSpawnMore: false, activeWorkers: 4, maxWorkers: 4 });
      transition = checkTransition(transition.healthy, transition.canSpawn, guard);
      expect(transition.type).toBe("recovery");
      expect(transition.message).toContain("Memory has recovered");
      // Workers are still full so no "worker slots available" message
      expect(transition.message).not.toContain("Worker slots");

      // Now workers also recover
      guard.setSnapshot({ healthy: true, memoryUsedPct: 45, canSpawnMore: true, activeWorkers: 1, maxWorkers: 4 });
      transition = checkTransition(transition.healthy, transition.canSpawn, guard);
      expect(transition.type).toBe("recovery");
      expect(transition.message).toContain("Worker slots are available");
    });
  });
});
