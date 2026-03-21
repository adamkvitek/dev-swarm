import { runCli } from "./cli-runner.js";
import { reviewerResponseSchema, parseCliJson } from "./schemas.js";
import { loadReviewChecklist } from "./standards-loader.js";
import { log } from "../logger.js";
import type { Env } from "../config/env.js";
import type { WorkerResult } from "./worker.js";
import type { ReviewScore, ReviewResult } from "./reviewer.js";

/**
 * Individual review from one council member.
 */
interface CouncilMemberReview {
  memberId: string;      // "claude", "codex", "gemini"
  anonymousLabel: string; // "Reviewer A", "Reviewer B", "Reviewer C"
  scores: ReviewScore;
  feedback: string;
  issuesBySubtask: Record<string, string[]>;
  raw: string;           // Full text response for ranking stage
  failed: boolean;
}

/**
 * Ranking from one council member evaluating the others.
 */
interface CouncilRanking {
  ranker: string;         // who did the ranking
  ranking: string[];      // ordered list: ["Reviewer A", "Reviewer C", "Reviewer B"]
  reasoning: string;
}

export interface CouncilReviewResult extends ReviewResult {
  councilMembers: string[];
  memberReviews: Array<{
    memberId: string;
    anonymousLabel: string;
    scores: ReviewScore;
    feedback: string;
  }>;
  rankings: CouncilRanking[];
  synthesisReasoning: string;
}

const ANONYMOUS_LABELS = ["Reviewer A", "Reviewer B", "Reviewer C", "Reviewer D", "Reviewer E"];

/**
 * Council-based code reviewer using multiple LLM models.
 *
 * Implements the LLM Council pattern:
 *   Stage 1: Fan out review to all models in parallel (Claude, Codex, Gemini)
 *   Stage 2: Anonymize reviews, each model ranks the others
 *   Stage 3: CTO (Claude) synthesizes final verdict from all reviews + rankings
 *
 * Anonymization prevents models from playing favorites when judging each other.
 */
export class CouncilReviewer {
  private claudeCli: string;
  private codexCli: string;
  private geminiCli: string;
  private qualityThreshold: number;

  constructor(env: Env) {
    this.claudeCli = env.CLAUDE_CLI;
    this.codexCli = env.CODEX_CLI;
    this.geminiCli = env.GEMINI_CLI;
    this.qualityThreshold = env.REVIEW_QUALITY_THRESHOLD;
  }

  async review(
    workerResults: WorkerResult[],
    taskDescription: string,
    iteration: number,
    signal?: AbortSignal,
  ): Promise<CouncilReviewResult> {
    const checklist = await loadReviewChecklist();
    const codeForReview = this.buildCodeContext(workerResults);
    const reviewCwd = workerResults[0]?.workDir;

    // ── Stage 1: Fan out to all council members ──
    log.reviewer.info({ iteration, stage: 1 }, "Council Stage 1: collecting reviews from all models");

    const memberReviews = await this.collectReviews(
      codeForReview, taskDescription, iteration, checklist, reviewCwd, signal,
    );

    const successfulReviews = memberReviews.filter((r) => !r.failed);
    if (successfulReviews.length === 0) {
      return this.failureResult(iteration, "All council members failed to produce reviews");
    }

    // ── Stage 2: Anonymized cross-ranking ──
    log.reviewer.info({ iteration, stage: 2, reviewers: successfulReviews.length }, "Council Stage 2: anonymized cross-ranking");

    const rankings = await this.crossRank(successfulReviews, taskDescription, signal);

    // ── Stage 3: CTO synthesis ──
    log.reviewer.info({ iteration, stage: 3 }, "Council Stage 3: CTO synthesis");

    const synthesis = await this.synthesize(
      successfulReviews, rankings, taskDescription, iteration, signal,
    );

    return synthesis;
  }

  // ── Stage 1: Parallel Review Collection ──

  private async collectReviews(
    codeForReview: string,
    taskDescription: string,
    iteration: number,
    checklist: string,
    reviewCwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<CouncilMemberReview[]> {
    const prompt = this.buildReviewPrompt(codeForReview, taskDescription, iteration, checklist);

    // Fan out to all three models in parallel
    const results = await Promise.allSettled([
      this.reviewWithClaude(prompt, reviewCwd, signal),
      this.reviewWithCodex(prompt, reviewCwd, signal),
      this.reviewWithGemini(prompt, reviewCwd, signal),
    ]);

    const members: CouncilMemberReview[] = [];
    const memberIds = ["claude", "codex", "gemini"];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      const memberId = memberIds[i] ?? "unknown";
      const label = ANONYMOUS_LABELS[i] ?? "?";

      if (result.status === "fulfilled" && result.value) {
        members.push({ ...result.value, memberId, anonymousLabel: label });
        log.reviewer.info({ memberId, label, avg: result.value.scores.average }, "Council member review complete");
      } else {
        const reason = result.status === "rejected" ? String(result.reason) : "empty response";
        log.reviewer.warn({ memberId, reason }, "Council member failed");
        members.push({
          memberId,
          anonymousLabel: label,
          scores: { correctness: 0, codeQuality: 0, testCoverage: 0, security: 0, completeness: 0, average: 0 },
          feedback: `Review failed: ${reason}`,
          issuesBySubtask: {},
          raw: "",
          failed: true,
        });
      }
    }

    return members;
  }

  private async reviewWithClaude(
    prompt: string, cwd: string | undefined, signal?: AbortSignal,
  ): Promise<Omit<CouncilMemberReview, "memberId" | "anonymousLabel"> | null> {
    const args = ["--print", "--output-format", "text", "--dangerously-skip-permissions"];
    if (cwd) args.push("--add-dir", cwd);

    const result = await runCli(this.claudeCli, args, {
      timeoutMs: 1_200_000, stdin: prompt, signal,
    });
    if (result.exitCode !== 0) return null;
    return this.parseReviewResponse(result.stdout);
  }

  private async reviewWithCodex(
    prompt: string, cwd: string | undefined, signal?: AbortSignal,
  ): Promise<Omit<CouncilMemberReview, "memberId" | "anonymousLabel"> | null> {
    const args = cwd
      ? ["exec", "--full-auto", "-C", cwd, "--json"]
      : ["exec", "--full-auto", "-"];

    const result = await runCli(this.codexCli, args, {
      timeoutMs: 1_200_000, stdin: prompt, signal,
    });
    if (result.exitCode !== 0) return null;
    return this.parseReviewResponse(result.stdout);
  }

  private async reviewWithGemini(
    prompt: string, cwd: string | undefined, signal?: AbortSignal,
  ): Promise<Omit<CouncilMemberReview, "memberId" | "anonymousLabel"> | null> {
    const args = ["-p", prompt, "--output-format", "text", "--yolo"];
    const result = await runCli(this.geminiCli, args, {
      timeoutMs: 1_200_000, cwd, signal,
    });
    if (result.exitCode !== 0) return null;
    return this.parseReviewResponse(result.stdout);
  }

  // ── Stage 2: Anonymized Cross-Ranking ──

  private async crossRank(
    reviews: CouncilMemberReview[],
    taskDescription: string,
    signal?: AbortSignal,
  ): Promise<CouncilRanking[]> {
    // Build anonymized review summaries
    const anonymizedReviews = reviews.map((r) =>
      `### ${r.anonymousLabel}\n` +
      `Scores: correctness=${r.scores.correctness}, quality=${r.scores.codeQuality}, ` +
      `tests=${r.scores.testCoverage}, security=${r.scores.security}, completeness=${r.scores.completeness}\n` +
      `Average: ${r.scores.average.toFixed(1)}\n` +
      `Feedback: ${r.feedback}\n` +
      `Issues found: ${Object.values(r.issuesBySubtask).flat().length}`
    ).join("\n\n");

    const rankPrompt = [
      `You are evaluating code reviews for this task: ${taskDescription}`,
      "",
      "Below are anonymized reviews from different reviewers. Evaluate each for accuracy, thoroughness, and insight.",
      "",
      anonymizedReviews,
      "",
      "Provide your ranking from best to worst, with brief reasoning.",
      "",
      "FINAL RANKING:",
      "1. [Reviewer X] - reason",
      "2. [Reviewer Y] - reason",
      "3. [Reviewer Z] - reason",
    ].join("\n");

    // Each model ranks the others — use Claude for this (fast, reliable for analysis)
    const result = await runCli(this.claudeCli, [
      "--print", "--output-format", "text", "--dangerously-skip-permissions",
    ], { timeoutMs: 300_000, stdin: rankPrompt, signal });

    if (result.exitCode !== 0) return [];

    const ranking = this.parseRanking(result.stdout, reviews);
    return ranking ? [ranking] : [];
  }

  // ── Stage 3: CTO Synthesis ──

  private async synthesize(
    reviews: CouncilMemberReview[],
    rankings: CouncilRanking[],
    taskDescription: string,
    iteration: number,
    signal?: AbortSignal,
  ): Promise<CouncilReviewResult> {
    // De-anonymize for synthesis — the CTO sees everything
    const reviewSummaries = reviews.map((r) =>
      `### ${r.memberId} (was ${r.anonymousLabel})\n` +
      `Scores: avg=${r.scores.average.toFixed(1)} (correctness=${r.scores.correctness}, quality=${r.scores.codeQuality}, tests=${r.scores.testCoverage}, security=${r.scores.security}, completeness=${r.scores.completeness})\n` +
      `Feedback: ${r.feedback}\n` +
      `Issues: ${JSON.stringify(r.issuesBySubtask)}`
    ).join("\n\n");

    const rankingSummary = rankings.length > 0
      ? `Rankings: ${rankings.map((r) => r.ranking.join(" > ")).join("; ")}`
      : "No rankings available.";

    const synthesisPrompt = [
      "You are the CTO synthesizing a code review from multiple reviewers.",
      "",
      `Task: ${taskDescription}`,
      `Quality threshold: average score >= ${this.qualityThreshold} to APPROVE.`,
      `Iteration: ${iteration}`,
      "",
      "## Individual Reviews (de-anonymized)",
      reviewSummaries,
      "",
      `## ${rankingSummary}`,
      "",
      "Synthesize a final review. Weight higher-ranked reviewers more heavily.",
      "Resolve disagreements between reviewers. If one reviewer found a security issue others missed, that matters.",
      "",
      "Respond ONLY with JSON (no markdown, no code fences):",
      '{"verdict": "APPROVE"|"REVISE", "scores": {"correctness": N, "codeQuality": N, "testCoverage": N, "security": N, "completeness": N}, "feedback": "synthesized assessment", "issuesBySubtask": {"id": ["issue"]}, "synthesisReasoning": "how you resolved disagreements"}',
    ].join("\n");

    const result = await runCli(this.claudeCli, [
      "--print", "--output-format", "text", "--dangerously-skip-permissions",
    ], { timeoutMs: 600_000, stdin: synthesisPrompt, signal });

    if (result.exitCode !== 0) {
      return this.aggregateFallback(reviews, rankings, iteration);
    }

    const parsed = parseCliJson(result.stdout, reviewerResponseSchema);
    if ("error" in parsed) {
      return this.aggregateFallback(reviews, rankings, iteration);
    }

    const scores = parsed.data.scores;
    const average = (scores.correctness + scores.codeQuality + scores.testCoverage + scores.security + scores.completeness) / 5;

    // Extract synthesis reasoning
    let synthesisReasoning = "";
    try {
      const raw = JSON.parse(result.stdout.match(/\{[\s\S]*\}/)?.at(0) ?? "{}");
      synthesisReasoning = raw.synthesisReasoning ?? "";
    } catch { /* ignore */ }

    return {
      verdict: average >= this.qualityThreshold ? "APPROVE" : "REVISE",
      scores: { ...scores, average },
      feedback: parsed.data.feedback,
      issuesBySubtask: parsed.data.issuesBySubtask,
      iteration,
      councilMembers: reviews.map((r) => r.memberId),
      memberReviews: reviews.map((r) => ({
        memberId: r.memberId,
        anonymousLabel: r.anonymousLabel,
        scores: r.scores,
        feedback: r.feedback,
      })),
      rankings,
      synthesisReasoning,
    };
  }

  // ── Helpers ──

  private buildCodeContext(workerResults: WorkerResult[]): string {
    return workerResults
      .map((r) =>
        `## Subtask: ${r.subtaskId}\nStatus: ${r.status}\n` +
        `Work dir: ${r.workDir}\nFiles changed: ${r.files.join(", ")}\n` +
        `Summary: ${r.summary}\n\n### Diff\n\`\`\`\n${r.diff.slice(0, 10_000)}\n\`\`\``)
      .join("\n\n---\n\n");
  }

  private buildReviewPrompt(
    codeForReview: string, taskDescription: string, iteration: number, checklist: string,
  ): string {
    return [
      REVIEWER_SYSTEM_PROMPT,
      `## Task Description\n${taskDescription}`,
      `## Quality Threshold\nAverage score must be >= ${this.qualityThreshold} to APPROVE.`,
      `## Iteration\n${iteration}`,
      checklist ? `## Review Checklist\n${checklist}` : "",
      `## Changes to Review\n${codeForReview}`,
      "",
      "Review the changes. Respond with the JSON object only.",
    ].filter(Boolean).join("\n\n");
  }

  private parseReviewResponse(
    stdout: string,
  ): Omit<CouncilMemberReview, "memberId" | "anonymousLabel"> | null {
    const text = stdout.trim();
    const parsed = parseCliJson(text, reviewerResponseSchema);

    if ("error" in parsed) {
      return null;
    }

    const scores = parsed.data.scores;
    const average = (scores.correctness + scores.codeQuality + scores.testCoverage + scores.security + scores.completeness) / 5;

    return {
      scores: { ...scores, average },
      feedback: parsed.data.feedback,
      issuesBySubtask: parsed.data.issuesBySubtask,
      raw: text,
      failed: false,
    };
  }

  private parseRanking(text: string, reviews: CouncilMemberReview[]): CouncilRanking | null {
    const rankingMatch = text.match(/FINAL RANKING:[\s\S]*/i);
    if (!rankingMatch) return null;

    const rankingText = rankingMatch[0];
    const labels = reviews.map((r) => r.anonymousLabel);
    const ranking: string[] = [];

    for (const label of ANONYMOUS_LABELS) {
      if (labels.includes(label) && rankingText.includes(label)) {
        ranking.push(label);
      }
    }

    // If we didn't find all labels in order, try numbered extraction
    if (ranking.length < reviews.length) {
      const numbered = rankingText.match(/\d+\.\s*(Reviewer [A-E])/gi);
      if (numbered) {
        ranking.length = 0;
        for (const match of numbered) {
          const label = match.replace(/^\d+\.\s*/, "").trim();
          if (labels.includes(label) && !ranking.includes(label)) {
            ranking.push(label);
          }
        }
      }
    }

    return ranking.length > 0
      ? { ranker: "claude-cto", ranking, reasoning: rankingText.slice(0, 1000) }
      : null;
  }

  /**
   * If CTO synthesis fails, fall back to averaging all council scores.
   */
  private aggregateFallback(
    reviews: CouncilMemberReview[],
    rankings: CouncilRanking[],
    iteration: number,
  ): CouncilReviewResult {
    const successful = reviews.filter((r) => !r.failed);
    const n = successful.length || 1;

    const avgScores: ReviewScore = {
      correctness: successful.reduce((s, r) => s + r.scores.correctness, 0) / n,
      codeQuality: successful.reduce((s, r) => s + r.scores.codeQuality, 0) / n,
      testCoverage: successful.reduce((s, r) => s + r.scores.testCoverage, 0) / n,
      security: successful.reduce((s, r) => s + r.scores.security, 0) / n,
      completeness: successful.reduce((s, r) => s + r.scores.completeness, 0) / n,
      average: 0,
    };
    avgScores.average = (avgScores.correctness + avgScores.codeQuality + avgScores.testCoverage + avgScores.security + avgScores.completeness) / 5;

    return {
      verdict: avgScores.average >= this.qualityThreshold ? "APPROVE" : "REVISE",
      scores: avgScores,
      feedback: `Council synthesis failed — using averaged scores from ${n} reviewers. ` +
        successful.map((r) => `${r.memberId}: ${r.feedback}`).join(" | "),
      issuesBySubtask: Object.assign({}, ...successful.map((r) => r.issuesBySubtask)),
      iteration,
      councilMembers: reviews.map((r) => r.memberId),
      memberReviews: reviews.map((r) => ({
        memberId: r.memberId,
        anonymousLabel: r.anonymousLabel,
        scores: r.scores,
        feedback: r.feedback,
      })),
      rankings,
      synthesisReasoning: "Synthesis failed — scores are averaged across council members.",
    };
  }

  private failureResult(iteration: number, reason: string): CouncilReviewResult {
    return {
      verdict: "REVISE",
      scores: { correctness: 0, codeQuality: 0, testCoverage: 0, security: 0, completeness: 0, average: 0 },
      feedback: reason,
      issuesBySubtask: {},
      iteration,
      councilMembers: [],
      memberReviews: [],
      rankings: [],
      synthesisReasoning: reason,
    };
  }
}

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer. Review the changes below.

Score each criterion from 1-10:
- **Correctness**: Does the code do what was asked? Are there bugs?
- **Code quality**: Clean code, proper naming, no duplication, good abstractions?
- **Test coverage**: Are there tests? Do they cover edge cases?
- **Security**: Any vulnerabilities? Input validation? Injection risks?
- **Completeness**: Is the full task implemented? Any missing pieces?

Respond ONLY with a JSON object (no markdown, no code fences):
{"verdict": "APPROVE"|"REVISE", "scores": {"correctness": N, "codeQuality": N, "testCoverage": N, "security": N, "completeness": N}, "feedback": "assessment", "issuesBySubtask": {"id": ["issue"]}}

Be rigorous but fair. Point out specific issues with file paths and line references.`;
