import { ClaudeSession } from "./claude-session.js";
import { ctoResponseSchema, parseCliJson } from "./schemas.js";
import { log } from "../logger.js";
import type { Env } from "../config/env.js";

export interface Subtask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
}

export interface TaskPlan {
  summary: string;
  subtasks: Subtask[];
  techStack: string[];
  decisions: string[];
}

const CTO_SYSTEM_PROMPT = `You are a CTO agent that decomposes development tasks.

Given a user request, either ask clarifying questions OR provide a task plan.

Respond ONLY with a JSON object. No markdown, no code fences, no explanation.

If you need clarifications:
{"clarifications_needed": ["question 1", "question 2"], "plan": null}

If the task is clear:
{"clarifications_needed": null, "plan": {"summary": "what this delivers", "subtasks": [{"id": "1", "title": "short title", "description": "what to implement", "dependencies": []}], "techStack": ["tech1"], "decisions": ["decision1"]}}`;

export class CTOAgent {
  private session: ClaudeSession;

  constructor(env: Env) {
    this.session = new ClaudeSession(env.CLAUDE_CLI, [
      "--dangerously-skip-permissions",
    ]);
  }

  async analyze(userRequest: string): Promise<{
    clarifications: string[] | null;
    plan: TaskPlan | null;
  }> {
    // First message includes the system prompt; subsequent messages just add context
    const prompt = this.session.isActive
      ? userRequest
      : `${CTO_SYSTEM_PROMPT}\n\nRequest: ${userRequest}\n\nJSON response:`;

    log.cto.info({ active: this.session.isActive, promptChars: prompt.length }, "Sending to session");

    const result = await this.session.send(prompt, { timeoutMs: 1_800_000 });

    log.cto.info({ durationMs: result.durationMs, costUsd: result.costUsd, preview: result.text.slice(0, 200) }, "Response received");

    const parsed = parseCliJson(result.text, ctoResponseSchema);
    if ("error" in parsed) {
      throw new Error(`CTO agent response invalid: ${parsed.error}`);
    }

    return {
      clarifications: parsed.data.clarifications_needed,
      plan: parsed.data.plan,
    };
  }

  async refineWithAnswers(answers: string): Promise<{
    clarifications: string[] | null;
    plan: TaskPlan | null;
  }> {
    // Session remembers the prior context — just send the answers
    return this.analyze(answers);
  }

  resetConversation(): void {
    this.session.reset();
  }
}
