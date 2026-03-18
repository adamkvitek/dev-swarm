import { CTOAgent, type TaskPlan } from "../agents/cto.js";
import { WorkerAgent, type WorkerResult } from "../agents/worker.js";
import { ReviewerAgent, type ReviewResult } from "../agents/reviewer.js";
import { ResearcherAgent } from "../agents/researcher.js";
import type { Env } from "../config/env.js";

export type PipelineEvent =
  | { type: "clarification"; questions: string[] }
  | { type: "plan"; plan: TaskPlan }
  | { type: "workers_started"; subtaskCount: number }
  | { type: "worker_completed"; subtaskTitle: string; index: number; total: number; status: string }
  | { type: "workers_completed"; results: WorkerResult[] }
  | { type: "review_started"; iteration: number }
  | { type: "review_completed"; review: ReviewResult }
  | { type: "iteration"; current: number; max: number }
  | { type: "approved"; finalReview: ReviewResult; code: WorkerResult[] }
  | { type: "max_iterations_reached"; lastReview: ReviewResult; code: WorkerResult[] }
  | { type: "pipeline_timeout"; completedWorkers: number; totalWorkers: number }
  | { type: "error"; message: string };

export type EventHandler = (event: PipelineEvent) => void | Promise<void>;

export class Pipeline {
  private cto: CTOAgent;
  private worker: WorkerAgent;
  private reviewer: ReviewerAgent;
  private researcher: ResearcherAgent;
  private maxIterations: number;
  private pipelineTimeoutMs: number;
  private onEvent: EventHandler;

  constructor(env: Env, onEvent: EventHandler) {
    this.cto = new CTOAgent(env);
    this.worker = new WorkerAgent(env);
    this.reviewer = new ReviewerAgent(env);
    this.researcher = new ResearcherAgent();
    this.maxIterations = env.MAX_REVIEW_ITERATIONS;
    this.pipelineTimeoutMs = env.PIPELINE_TIMEOUT_MS;
    this.onEvent = onEvent;
  }

  async start(userRequest: string): Promise<void> {
    const analysis = await this.cto.analyze(userRequest);

    if (analysis.clarifications) {
      await this.onEvent({
        type: "clarification",
        questions: analysis.clarifications,
      });
      return;
    }

    if (analysis.plan) {
      await this.onEvent({ type: "plan", plan: analysis.plan });
    }
  }

  async continueWithAnswers(answers: string): Promise<void> {
    const analysis = await this.cto.refineWithAnswers(answers);

    if (analysis.clarifications) {
      await this.onEvent({
        type: "clarification",
        questions: analysis.clarifications,
      });
      return;
    }

    if (analysis.plan) {
      await this.onEvent({ type: "plan", plan: analysis.plan });
    }
  }

  async executePlan(plan: TaskPlan): Promise<void> {
    let workerResults: WorkerResult[] = [];
    let lastReview: ReviewResult | null = null;

    // Pipeline-level timeout
    const pipelineTimer = setTimeout(() => {
      // This doesn't kill running processes but will be caught by Promise.race if we add it
      console.log(`[PIPELINE] Total timeout reached (${this.pipelineTimeoutMs}ms)`);
    }, this.pipelineTimeoutMs);

    try {
      for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
        await this.onEvent({
          type: "iteration",
          current: iteration,
          max: this.maxIterations,
        });

        // Dispatch workers with progress callback
        await this.onEvent({
          type: "workers_started",
          subtaskCount: plan.subtasks.length,
        });

        const feedback = lastReview?.feedback;
        workerResults = await this.worker.executeParallel(
          plan.subtasks,
          {
            techStack: plan.techStack,
            previousFeedback: feedback,
          },
          async (result, index, total) => {
            await this.onEvent({
              type: "worker_completed",
              subtaskTitle: result.subtaskId,
              index,
              total,
              status: result.status,
            });
          }
        );

        await this.onEvent({ type: "workers_completed", results: workerResults });

        // Review
        await this.onEvent({ type: "review_started", iteration });

        const review = await this.reviewer.review(
          workerResults,
          plan.summary,
          iteration
        );
        lastReview = review;

        await this.onEvent({ type: "review_completed", review });

        if (review.verdict === "APPROVE") {
          await this.onEvent({
            type: "approved",
            finalReview: review,
            code: workerResults,
          });
          return;
        }
      }

      await this.onEvent({
        type: "max_iterations_reached",
        lastReview: lastReview!,
        code: workerResults,
      });
    } finally {
      clearTimeout(pipelineTimer);
    }
  }

  async research(query: string): Promise<string> {
    if (!this.researcher.isAvailable()) {
      return "Perplexity not configured — skipping research.";
    }
    const result = await this.researcher.research(query);
    return `${result.answer}\n\nSources:\n${result.sources.map((s) => `- ${s}`).join("\n")}`;
  }
}
