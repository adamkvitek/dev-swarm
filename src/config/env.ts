import { z } from "zod";
import { cpus, homedir, totalmem } from "node:os";
import { config } from "dotenv";
import { log } from "../logger.js";

config();

/**
 * Derive sensible defaults from the current machine's hardware.
 * Goal: 50% of CPU cores for workers, 50% of RAM as memory ceiling.
 */
function detectHardware(): { cores: number; ramGb: number; defaultWorkers: number; defaultMemPct: number } {
  const cores = cpus().length;
  const ramGb = Math.round(totalmem() / (1024 * 1024 * 1024));
  const defaultWorkers = Math.max(1, Math.floor(cores / 2));
  // Memory ceiling: 85% of RAM on macOS (counts inactive/cached as "used"),
  // 80% on Linux (reports memory more accurately).
  const isMacOS = process.platform === "darwin";
  const defaultMemPct = isMacOS ? 85 : 80;
  return { cores, ramGb, defaultWorkers, defaultMemPct };
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
    cores: hw.cores,
    ramGb: hw.ramGb,
    workers: env.MAX_CONCURRENT_WORKERS,
    memoryCeilingPct: env.MEMORY_CEILING_PCT,
  }, "Hardware detected, config loaded");

  return env;
}
