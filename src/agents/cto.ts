import { runCli } from "./cli-runner.js";
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

const CTO_SYSTEM_PROMPT = `You are a CTO agent. Your role is to:
1. Understand the user's request fully — ask clarifying questions if anything is ambiguous.
2. Decompose the task into discrete, independently implementable subtasks.
3. Identify the tech stack, architectural decisions, and dependencies.
4. Return a structured task plan.

You NEVER write code. You decompose, delegate, and decide.

Respond ONLY with a JSON object (no markdown, no code fences) matching this structure:
{
  "clarifications_needed": string[] | null,
  "plan": {
    "summary": string,
    "subtasks": [{ "id": string, "title": string, "description": string, "dependencies": string[] }],
    "techStack": string[],
    "decisions": string[]
  } | null
}

If you need clarifications, set "plan" to null and list your questions.
If the task is clear, set "clarifications_needed" to null and provide the plan.`;

export class CTOAgent {
  private claudeCli: string;
  private conversationContext: string[] = [];

  constructor(env: Env) {
    this.claudeCli = env.CLAUDE_CLI;
  }

  async analyze(userRequest: string): Promise<{
    clarifications: string[] | null;
    plan: TaskPlan | null;
  }> {
    this.conversationContext.push(`User request: ${userRequest}`);

    const fullPrompt = [
      CTO_SYSTEM_PROMPT,
      "",
      "## Conversation so far:",
      ...this.conversationContext,
      "",
      "Respond with the JSON object only.",
    ].join("\n");

    const result = await runCli(this.claudeCli, [
      "--print",
      "--output-format", "text",
      fullPrompt,
    ], { timeoutMs: 120_000 });

    if (result.exitCode !== 0) {
      throw new Error(`CTO agent failed: ${result.stderr}`);
    }

    const text = result.stdout.trim();
    this.conversationContext.push(`CTO response: ${text}`);

    // Extract JSON from response (handle potential markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`CTO agent returned non-JSON response: ${text.slice(0, 200)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      clarifications_needed: string[] | null;
      plan: TaskPlan | null;
    };

    return {
      clarifications: parsed.clarifications_needed,
      plan: parsed.plan,
    };
  }

  async refineWithAnswers(answers: string): Promise<{
    clarifications: string[] | null;
    plan: TaskPlan | null;
  }> {
    return this.analyze(answers);
  }

  resetConversation(): void {
    this.conversationContext = [];
  }
}
