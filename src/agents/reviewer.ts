import OpenAI from "openai";
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

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer (Codex). You review code produced by a development team.

Score each criterion from 1-10:
- **Correctness**: Does the code do what was asked? Are there bugs?
- **Code quality**: Clean code, proper naming, no duplication, good abstractions?
- **Test coverage**: Are there tests? Do they cover edge cases?
- **Security**: Any vulnerabilities? Input validation? Injection risks?
- **Completeness**: Is the full task implemented? Any missing pieces?

Respond with a JSON object:
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
  private client: OpenAI;
  private qualityThreshold: number;

  constructor(env: Env) {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
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

    const response = await this.client.chat.completions.create({
      model: "o3",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: REVIEWER_SYSTEM_PROMPT },
        {
          role: "user",
          content: `## Task Description\n${taskDescription}\n\n## Quality Threshold\nAverage score must be >= ${this.qualityThreshold} to APPROVE.\n\n## Iteration\n${iteration} of max review cycles.\n\n## Code to Review\n${codeForReview}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as {
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
  }
}
