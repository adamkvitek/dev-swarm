import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runCli } from "./cli-runner.js";
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

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer. You review code produced by a development team.

Score each criterion from 1-10:
- **Correctness**: Does the code do what was asked? Are there bugs?
- **Code quality**: Clean code, proper naming, no duplication, good abstractions?
- **Test coverage**: Are there tests? Do they cover edge cases?
- **Security**: Any vulnerabilities? Input validation? Injection risks?
- **Completeness**: Is the full task implemented? Any missing pieces?

Respond ONLY with a JSON object (no markdown, no code fences):
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
    iteration: number
  ): Promise<ReviewResult> {
    const codeForReview = workerResults
      .map(
        (r) =>
          `## Subtask: ${r.subtaskId}\nStatus: ${r.status}\nFiles: ${r.files.join(", ")}\n\n${r.code}`
      )
      .join("\n\n---\n\n");

    const fullPrompt = [
      REVIEWER_SYSTEM_PROMPT,
      "",
      `## Task Description\n${taskDescription}`,
      `## Quality Threshold\nAverage score must be >= ${this.qualityThreshold} to APPROVE.`,
      `## Iteration\n${iteration} of max review cycles.`,
      `## Code to Review\n${codeForReview}`,
      "",
      "Respond with the JSON object only.",
    ].join("\n\n");

    // Write prompt to temp file to avoid shell argument issues
    const tmpFile = join(tmpdir(), `reviewer-${randomUUID()}.txt`);
    await writeFile(tmpFile, fullPrompt, "utf-8");
    console.log(`[REVIEWER] Starting review (iteration ${iteration})...`);

    const result = await runCli("bash", [
      "-c",
      `cat "${tmpFile}" | ${this.codexCli} exec --full-auto -`,
    ], { timeoutMs: 600_000 }); // 10 min

    await unlink(tmpFile).catch(() => {});

    if (result.exitCode !== 0) {
      // If codex fails, return a REVISE with the error
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

    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        verdict: "APPROVE" | "REVISE";
        scores: Omit<ReviewScore, "average">;
        feedback: string;
        issuesBySubtask: Record<string, string[]>;
      };

      const scores = parsed.scores;
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
        feedback: parsed.feedback,
        issuesBySubtask: parsed.issuesBySubtask,
        iteration,
      };
    } catch {
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
        feedback: `Failed to parse reviewer output: ${text.slice(0, 500)}`,
        issuesBySubtask: {},
        iteration,
      };
    }
  }
}
