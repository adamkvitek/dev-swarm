import { z } from "zod";

/**
 * Zod schemas for validating JSON responses from CLI tools.
 *
 * Replaces unsafe `as` type casts with runtime validation.
 * All Claude/Codex CLI responses pass through these schemas
 * before being used by business logic.
 */

/** Claude CLI --output-format json response */
export const claudeSessionResponseSchema = z.object({
  result: z.string(),
  session_id: z.string(),
  total_cost_usd: z.number(),
  duration_ms: z.number(),
});
export type ClaudeSessionResponse = z.infer<typeof claudeSessionResponseSchema>;

/** CTO agent response */
export const ctoResponseSchema = z.object({
  clarifications_needed: z.array(z.string()).nullable(),
  plan: z.object({
    summary: z.string(),
    subtasks: z.array(z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      dependencies: z.array(z.string()),
    })),
    techStack: z.array(z.string()),
    decisions: z.array(z.string()),
  }).nullable(),
});
export type CTOResponse = z.infer<typeof ctoResponseSchema>;

/** Reviewer agent response (from Codex) */
export const reviewerResponseSchema = z.object({
  verdict: z.enum(["APPROVE", "REVISE"]),
  scores: z.object({
    correctness: z.number().min(0).max(10),
    codeQuality: z.number().min(0).max(10),
    testCoverage: z.number().min(0).max(10),
    security: z.number().min(0).max(10),
    completeness: z.number().min(0).max(10),
  }),
  feedback: z.string(),
  issuesBySubtask: z.record(z.string(), z.array(z.string())),
});
export type ReviewerResponse = z.infer<typeof reviewerResponseSchema>;

/**
 * Safely parse JSON from CLI stdout.
 * Extracts the first JSON object from the text and validates against schema.
 * Returns null if parsing fails (caller decides how to handle).
 */
export function parseCliJson<T>(
  text: string,
  schema: z.ZodType<T>,
): { data: T } | { error: string } {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { error: `No JSON object found in response: ${text.slice(0, 200)}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch {
    return { error: `Invalid JSON: ${jsonMatch[0].slice(0, 200)}` };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    return { error: `Schema validation failed: ${issues}` };
  }

  return { data: result.data };
}
