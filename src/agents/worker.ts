import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../config/env.js";
import type { Subtask } from "./cto.js";

export interface WorkerResult {
  subtaskId: string;
  status: "completed" | "blocked";
  code: string;
  files: string[];
  blockerReason?: string;
}

const WORKER_SYSTEM_PROMPT = `You are a senior developer agent in a development swarm. You receive a specific subtask and implement it.

Rules:
- Write clean, production-quality code.
- Include appropriate error handling and types.
- Follow the tech stack and patterns specified.
- If blocked, explain what you need and return status "blocked".

Respond with a JSON object:
{
  "status": "completed" | "blocked",
  "files": [{ "path": string, "content": string }],
  "blockerReason": string | null,
  "notes": string
}`;

export class WorkerAgent {
  private client: Anthropic;

  constructor(private env: Env) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async execute(
    subtask: Subtask,
    context: {
      techStack: string[];
      previousFeedback?: string;
      otherWorkerOutputs?: Map<string, string>;
    }
  ): Promise<WorkerResult> {
    const contextParts: string[] = [
      `## Subtask: ${subtask.title}`,
      subtask.description,
      `\n## Tech Stack: ${context.techStack.join(", ")}`,
    ];

    if (context.previousFeedback) {
      contextParts.push(
        `\n## Reviewer Feedback (fix these issues):\n${context.previousFeedback}`
      );
    }

    if (context.otherWorkerOutputs?.size) {
      contextParts.push("\n## Other workers' outputs (for context):");
      for (const [id, output] of context.otherWorkerOutputs) {
        contextParts.push(`### ${id}:\n${output}`);
      }
    }

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: WORKER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: contextParts.join("\n") }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const parsed = JSON.parse(text) as {
      status: "completed" | "blocked";
      files: Array<{ path: string; content: string }>;
      blockerReason: string | null;
      notes: string;
    };

    return {
      subtaskId: subtask.id,
      status: parsed.status,
      code: parsed.files.map((f) => `// ${f.path}\n${f.content}`).join("\n\n"),
      files: parsed.files.map((f) => f.path),
      blockerReason: parsed.blockerReason ?? undefined,
    };
  }

  async executeParallel(
    subtasks: Subtask[],
    context: { techStack: string[]; previousFeedback?: string }
  ): Promise<WorkerResult[]> {
    const results = await Promise.all(
      subtasks.map((subtask) => this.execute(subtask, context))
    );
    return results;
  }
}
