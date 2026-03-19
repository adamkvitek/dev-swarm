import { z } from "zod";
import { cpus, homedir, totalmem, platform } from "node:os";
import { config } from "dotenv";
import { log } from "../logger.js";

config();

/**
 * Derive sensible defaults from the current machine's hardware.
 * OS-aware: handles macOS, Linux, and Windows memory reporting differences.
 */
function detectHardware(): { cores: number; ramGb: number; defaultWorkers: number; defaultMemPct: number; os: string } {
  const cores = cpus().length;
  const ramGb = Math.round(totalmem() / (1024 * 1024 * 1024));
  const defaultWorkers = Math.max(1, Math.floor(cores / 2));
  const os = platform();

  // Memory ceiling defaults per OS:
  // - macOS (darwin): 85% — os.freemem() excludes inactive/cached pages,
  //   making memory look much more used than it is
  // - Linux: 80% — we read MemAvailable from /proc/meminfo for accuracy
  // - Windows (win32): 80% — os.freemem() reports actual available memory
  let defaultMemPct: number;
  switch (os) {
    case "darwin": defaultMemPct = 85; break;
    case "linux":  defaultMemPct = 80; break;
    case "win32":  defaultMemPct = 80; break;
    default:       defaultMemPct = 80; break;
  }

  return { cores, ramGb, defaultWorkers, defaultMemPct, os };
}

const hw = detectHardware();

const envSchema = z.object({
  // Required
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),

  // CLI paths (uses existing subscriptions)
  CLAUDE_CLI: z.string().default("claude"),
  CODEX_CLI: z.string().default("codex"),

  // Claude adapter
  SYSTEM_PROMPT_PATH: z.string().default("prompts/system.md"),
  MAX_MESSAGE_AGE_MS: z.coerce.number().int().min(5_000).default(60_000), // Ignore messages older than 60s
  CLAUDE_RESPONSE_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(300_000), // 5 min default
  MEMORY_CEILING_PCT: z.coerce.number().int().min(50).max(95).default(hw.defaultMemPct),

  // Review loop config
  MAX_REVIEW_ITERATIONS: z.coerce.number().int().min(1).max(5).default(3),
  REVIEW_QUALITY_THRESHOLD: z.coerce.number().int().min(1).max(10).default(8),
  WORKSPACE_DIR: z.string().default("~/dev/swarm-workspace")
    .transform((p) => p.startsWith("~") ? p.replace("~", homedir()) : p),

  // Concurrency and timeouts — defaults derived from hardware
  MAX_CONCURRENT_WORKERS: z.coerce.number().int().min(1).max(15).default(hw.defaultWorkers),
  PIPELINE_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(14_400_000), // 4 hours

  // MCP internal API
  MCP_API_HOST: z.string().default("127.0.0.1"),
  MCP_API_PORT: z.coerce.number().int().min(1024).max(65535).default(9847),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Detected hardware info — exposed for logging and first-run messages.
 */
export const detectedHardware = hw;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${missing}`);
  }

  const env = result.data;
  log.config.info({
    os: hw.os,
    cores: hw.cores,
    ramGb: hw.ramGb,
    workers: env.MAX_CONCURRENT_WORKERS,
    memoryCeilingPct: env.MEMORY_CEILING_PCT,
  }, "Hardware detected, config loaded");

  return env;
}
