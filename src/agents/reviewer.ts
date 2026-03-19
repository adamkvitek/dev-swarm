import { runCli } from "./cli-runner.js";
import { reviewerResponseSchema, parseCliJson } from "./schemas.js";
import type { Env } from "../config/env.js";
import type { WorkerResult } from "./worker.js";

export interface ReviewScore {
  correctness: number;
  codeQuality: number;
  testCoverage: number;
  security: number;
  completeness: number;
  average: number;
}

export interface ReviewResult {
  verdict: "APPROVE" | "REVISE";
  scores: ReviewScore;
  feedback: string;
  issuesBySubtask: Record<string, string[]>;
  iteration: number;
}

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer with full access to the codebase.

Review the changes in this worktree. You can:
- Read any file to understand context
- Write and run test scripts to verify correctness
- Run linters (check package.json scripts, Makefile, etc.)
- Check for security issues, code quality, and completeness

Score each criterion from 1-10:
- **Correctness**: Does the code do what was asked? Are there bugs?
- **Code quality**: Clean code, proper naming, no duplication, good abstractions?
- **Test coverage**: Are there tests? Do they cover edge cases?
- **Security**: Any vulnerabilities? Input validation? Injection risks?
- **Completeness**: Is the full task implemented? Any missing pieces?

After your review, respond ONLY with a JSON object (no markdown, no code fences):
{
  "verdict": "APPROVE" | "REVISE",
  "scores": {
    "correctness": number,
    "codeQuality": number,
    "testCoverage": number,
    "security": number,
    "completeness": number
  },
  "feedback": "Overall assessment",
  "issuesBySubtask": {
    "subtask-id": ["specific issue 1", "specific issue 2"]
  }
}

Set verdict to "APPROVE" if the average score >= the quality threshold.
Be rigorous but fair. Point out specific issues with file paths and line references.`;

export class ReviewerAgent {
  private codexCli: string;
  private qualityThreshold: number;

  constructor(env: Env) {
    this.codexCli = env.CODEX_CLI;
    this.qualityThreshold = env.REVIEW_QUALITY_THRESHOLD;
  }

  async review(
    workerResults: WorkerResult[],
    taskDescription: string,
    iteration: number,
    signal?: AbortSignal,
  ): Promise<ReviewResult> {
    // Build review context with diffs and file lists per subtask
    const codeForReview = workerResults
      .map(
        (r) =>
          `## Subtask: ${r.subtaskId}\nStatus: ${r.status}\n` +
          `Work dir: ${r.workDir}\nFiles changed: ${r.files.join(", ")}\n` +
          `Summary: ${r.summary}\n\n### Diff\n\`\`\`\n${r.diff.slice(0, 10_000)}\n\`\`\``
      )
      .join("\n\n---\n\n");

    const fullPrompt = [
      `## Task Description\n${taskDescription}`,
      `## Quality Threshold\nAverage score must be >= ${this.qualityThreshold} to APPROVE.`,
      `## Iteration\n${iteration} of max review cycles.`,
      `## Changes to Review\n${codeForReview}`,
      "",
      "Review the changes. Read the actual files for full context. Run tests if possible.",
      "Respond with the JSON object only.",
    ].join("\n\n");

    console.log(`[REVIEWER] Starting review (iteration ${iteration})...`);

    // Use the first worker's workDir as the review cwd — reviewer can read across worktrees
    const reviewCwd = workerResults[0]?.workDir;

    let result;
    if (reviewCwd) {
      // Full agentic mode: Codex runs in the worktree with filesystem access
      result = await runCli(this.codexCli, [
        "exec", "--full-auto", "-C", reviewCwd, "--json",
        "-c", 'sandbox_permissions=["disk-full-read-access"]',
      ], { timeoutMs: 1_800_000, stdin: fullPrompt, signal }); // 30 min
    } else {
      // Fallback: stdin-only review (no worktree available)
      result = await runCli(this.codexCli, [
        "exec", "--full-auto", "-",
      ], { timeoutMs: 1_800_000, stdin: fullPrompt, signal });
    }

    if (result.exitCode !== 0) {
      return {
        verdict: "REVISE",
        scores: {
          correctness: 0,
          codeQuality: 0,
          testCoverage: 0,
          security: 0,
          completeness: 0,
          average: 0,
        },
        feedback: `Reviewer CLI error: ${result.stderr}`,
        issuesBySubtask: {},
        iteration,
      };
    }

    const text = result.stdout.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return {
        verdict: "REVISE",
        scores: {
          correctness: 5,
          codeQuality: 5,
          testCoverage: 5,
          security: 5,
          completeness: 5,
          average: 5,
        },
        feedback: `Reviewer returned non-structured response: ${text.slice(0, 500)}`,
        issuesBySubtask: {},
        iteration,
      };
    }

    const parsed = parseCliJson(text, reviewerResponseSchema);
    if ("error" in parsed) {
      return {
        verdict: "REVISE",
        scores: {
          correctness: 5,
          codeQuality: 5,
          testCoverage: 5,
          security: 5,
          completeness: 5,
          average: 5,
        },
        feedback: `Failed to parse reviewer output: ${parsed.error}`,
        issuesBySubtask: {},
        iteration,
      };
    }

    const scores = parsed.data.scores;
    const average =
      (scores.correctness +
        scores.codeQuality +
        scores.testCoverage +
        scores.security +
        scores.completeness) /
      5;

    return {
      verdict: average >= this.qualityThreshold ? "APPROVE" : "REVISE",
      scores: { ...scores, average },
      feedback: parsed.data.feedback,
      issuesBySubtask: parsed.data.issuesBySubtask,
      iteration,
    };
  }
}
