import { resolve } from "node:path";
import { runCli } from "../agents/cli-runner.js";

/**
 * Control plane protection for self-modification safety.
 *
 * When AI agents target the dev-swarm repo itself, these guardrails
 * prevent workers from modifying the bot's own infrastructure code.
 *
 * Defense model:
 *   1. Deterministic path checking (not prompt-based — prompts are suggestions, this is enforcement)
 *   2. Pre-merge validation (block merge if control plane files are in the diff)
 *   3. Self-repo detection (restrict worker capabilities when targeting own codebase)
 *
 * An agent can READ the control plane (needed for context). It can PROPOSE
 * changes via a branch. But it can NEVER auto-merge control plane changes.
 */

/**
 * Paths that constitute the bot's control plane.
 * Workers must never auto-merge changes to these paths.
 * Patterns use prefix matching (e.g. "src/adapter/" matches all files under it).
 */
const CONTROL_PLANE_PATTERNS: string[] = [
  "src/adapter/",
  "src/config/",
  "src/workspace/",
  "src/mcp/",
  "src/agents/",
  "src/index.ts",
  ".claude/",
  ".env",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "CODEOWNERS",
  ".github/",
];

/**
 * Files that agents should never write to, even in a worktree.
 * These are the guardrails themselves — modifying them is a privilege escalation.
 */
const NEVER_MODIFY_PATTERNS: string[] = [
  ".claude/",
  ".env",
  "CODEOWNERS",
  ".github/workflows/",
];

export interface DiffValidation {
  safe: boolean;
  controlPlaneFiles: string[];
  neverModifyFiles: string[];
  reason?: string;
}

/**
 * Check if a file path matches any control plane pattern.
 */
function matchesPatterns(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/")) {
      return filePath.startsWith(pattern);
    }
    return filePath === pattern || filePath.startsWith(pattern + "/");
  });
}

/**
 * Validate a list of changed files against control plane protections.
 * Returns whether the changes are safe to auto-merge.
 */
export function validateChangedFiles(files: string[]): DiffValidation {
  const controlPlaneFiles = files.filter((f) => matchesPatterns(f, CONTROL_PLANE_PATTERNS));
  const neverModifyFiles = files.filter((f) => matchesPatterns(f, NEVER_MODIFY_PATTERNS));

  if (neverModifyFiles.length > 0) {
    return {
      safe: false,
      controlPlaneFiles,
      neverModifyFiles,
      reason:
        `BLOCKED: Worker modified guardrail files that must never be changed by agents: ` +
        `${neverModifyFiles.join(", ")}. These files control the safety boundaries of the system.`,
    };
  }

  if (controlPlaneFiles.length > 0) {
    return {
      safe: false,
      controlPlaneFiles,
      neverModifyFiles: [],
      reason:
        `REQUIRES HUMAN REVIEW: Worker modified control plane files: ` +
        `${controlPlaneFiles.join(", ")}. ` +
        `Changes to the bot's own infrastructure cannot be auto-merged. ` +
        `The changes are on a feature branch for manual review.`,
    };
  }

  return {
    safe: true,
    controlPlaneFiles: [],
    neverModifyFiles: [],
  };
}

/**
 * Get the list of files changed in a worktree branch relative to its base.
 */
export async function getWorktreeChangedFiles(
  repoPath: string,
  branch: string,
): Promise<string[]> {
  // Get the merge base between main and the worker branch
  const baseResult = await runCli("git", [
    "-C", repoPath, "merge-base", "HEAD", branch,
  ], { timeoutMs: 10_000 });

  if (baseResult.exitCode !== 0) {
    // Fallback: just get all files in the branch diff
    const diffResult = await runCli("git", [
      "-C", repoPath, "diff", "--name-only", `${branch}~1`, branch,
    ], { timeoutMs: 10_000 });
    return diffResult.stdout.trim().split("\n").filter(Boolean);
  }

  const base = baseResult.stdout.trim();
  const diffResult = await runCli("git", [
    "-C", repoPath, "diff", "--name-only", base, branch,
  ], { timeoutMs: 10_000 });

  return diffResult.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Detect if a repo path points to the dev-swarm repository itself.
 * Uses heuristics: checks for distinctive files that identify this project.
 */
export async function isSelfRepo(repoPath: string): Promise<boolean> {
  const resolved = resolve(repoPath);

  // Check for the unique combination of files that identify dev-swarm
  const result = await runCli("git", [
    "-C", resolved, "ls-files",
    "src/workspace/worktree-manager.ts",
    "src/adapter/discord-adapter.ts",
    "src/mcp/server.ts",
  ], { timeoutMs: 5_000 });

  if (result.exitCode !== 0) return false;

  const files = result.stdout.trim().split("\n").filter(Boolean);
  // If all 3 distinctive files exist, this is almost certainly dev-swarm
  return files.length >= 3;
}

/**
 * Additional system prompt instructions for workers targeting the bot's own repo.
 */
export const SELF_REPO_WORKER_ADDENDUM = `
## CRITICAL: You are modifying the bot's own codebase

This repository IS the AI orchestration system that spawned you. Extra rules apply:

1. You may READ any file for context.
2. You may WRITE code in non-infrastructure paths (e.g. adding new features in new files).
3. You must NOT modify these control plane paths (your changes will be rejected):
   - src/adapter/ (Discord adapter, job manager, HTTP API)
   - src/config/ (environment configuration)
   - src/workspace/ (worktree manager, safety guardrails)
   - src/mcp/ (MCP server and tools)
   - src/agents/ (worker, reviewer, CLI runner)
   - src/index.ts (entrypoint)
   - .claude/ (hooks, settings, phase files)
   - .env, package.json, tsconfig.json, CODEOWNERS
4. If your task requires modifying these files, implement what you can and note what needs human intervention.
5. Do NOT attempt to modify safety guardrails, hooks, or permission settings.

Your changes will be reviewed by a human before merging. This is non-negotiable.`;
