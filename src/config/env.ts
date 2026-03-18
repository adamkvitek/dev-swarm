import { z } from "zod";
import { config } from "dotenv";

config();

const envSchema = z.object({
  // Required
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),

  // Optional
  PERPLEXITY_API_KEY: z.string().optional(),
  MAX_REVIEW_ITERATIONS: z.coerce.number().int().min(1).max(20).default(10),
  REVIEW_QUALITY_THRESHOLD: z.coerce.number().int().min(1).max(10).default(8),
  WORKSPACE_DIR: z.string().default("~/dev/swarm-workspace"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${missing}`);
  }
  return result.data;
}
