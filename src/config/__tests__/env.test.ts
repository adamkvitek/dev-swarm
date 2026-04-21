import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dotenv so it doesn't load .env file during tests
vi.mock("dotenv", () => ({ config: vi.fn() }));

describe("env schema", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should succeed without DISCORD_BOT_TOKEN (headless mode)", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const { loadEnv } = await import("../env.js");
    const env = loadEnv();
    expect(env.DISCORD_BOT_TOKEN).toBe("");
  });

  it("should pass through DISCORD_BOT_TOKEN when set", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token-123";
    const { loadEnv } = await import("../env.js");
    const env = loadEnv();
    expect(env.DISCORD_BOT_TOKEN).toBe("test-token-123");
    expect(env.CLAUDE_CLI).toBe("claude");
    expect(env.CODEX_CLI).toBe("codex");
    expect(env.MCP_API_PORT).toBe(9847);
  });

  it("should coerce numeric values from strings", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.MCP_API_PORT = "3000";
    process.env.MAX_CONCURRENT_WORKERS = "8";
    process.env.MEMORY_CEILING_PCT = "75";
    const { loadEnv } = await import("../env.js");
    const env = loadEnv();
    expect(env.MCP_API_PORT).toBe(3000);
    expect(env.MAX_CONCURRENT_WORKERS).toBe(8);
    expect(env.MEMORY_CEILING_PCT).toBe(75);
  });

  it("should enforce min/max on MEMORY_CEILING_PCT", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.MEMORY_CEILING_PCT = "30"; // below min of 50
    const { loadEnv } = await import("../env.js");
    expect(() => loadEnv()).toThrow();
  });

  it("should enforce min/max on MAX_CONCURRENT_WORKERS", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.MAX_CONCURRENT_WORKERS = "0"; // below min of 1
    const { loadEnv } = await import("../env.js");
    expect(() => loadEnv()).toThrow();
  });

  it("should resolve ~ in WORKSPACE_DIR", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.WORKSPACE_DIR = "~/custom-workspace";
    const { loadEnv } = await import("../env.js");
    const env = loadEnv();
    expect(env.WORKSPACE_DIR).not.toContain("~");
    expect(env.WORKSPACE_DIR).toContain("custom-workspace");
  });

  it("should leave absolute WORKSPACE_DIR unchanged", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.WORKSPACE_DIR = "/tmp/workspace";
    const { loadEnv } = await import("../env.js");
    const env = loadEnv();
    expect(env.WORKSPACE_DIR).toBe("/tmp/workspace");
  });

  it("should expose detected hardware info", async () => {
    const { detectedHardware } = await import("../env.js");
    expect(detectedHardware.cores).toBeGreaterThanOrEqual(1);
    expect(detectedHardware.ramGb).toBeGreaterThanOrEqual(1);
    expect(detectedHardware.defaultWorkers).toBeGreaterThanOrEqual(1);
    expect(detectedHardware.defaultMemPct).toBeGreaterThanOrEqual(50);
    expect(detectedHardware.defaultMemPct).toBeLessThanOrEqual(95);
  });

  it("should derive MAX_CONCURRENT_WORKERS from CPU cores by default", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    delete process.env.MAX_CONCURRENT_WORKERS;
    const { loadEnv, detectedHardware } = await import("../env.js");
    const env = loadEnv();
    expect(env.MAX_CONCURRENT_WORKERS).toBe(detectedHardware.defaultWorkers);
  });
});
