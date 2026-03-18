import Anthropic from "@anthropic-ai/sdk";
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

Respond with a JSON object matching this structure:
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
  private client: Anthropic;
  private conversationHistory: Anthropic.MessageParam[] = [];

  constructor(env: Env) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async analyze(userRequest: string): Promise<{
    clarifications: string[] | null;
    plan: TaskPlan | null;
  }> {
    this.conversationHistory.push({
      role: "user",
      content: userRequest,
    });

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: CTO_SYSTEM_PROMPT,
      messages: this.conversationHistory,
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    this.conversationHistory.push({
      role: "assistant",
      content: text,
    });

    const parsed = JSON.parse(text) as {
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
    this.conversationHistory = [];
  }
}
