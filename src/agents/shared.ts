/**
 * Shared constants and utilities for worker agents.
 * Prevents duplication between worker.ts and council-worker.ts.
 */

export const WORKER_SYSTEM_PROMPT = `You are a senior developer agent working on a real codebase.
Read relevant existing code before writing. Write clean production code.
Follow existing patterns and conventions you find in the codebase.
Run tests if a test runner exists (check package.json scripts, Makefile, etc.).
Include error handling and proper types.

When done, provide a brief summary of what you changed and why.`;

/**
 * Extract a summary from Claude's text output.
 * Takes the last paragraph or last few lines as a summary.
 */
export function extractSummary(text: string): string {
  const lines = text.trim().split("\n");
  return lines.slice(-10).join("\n").slice(0, 2000);
}
