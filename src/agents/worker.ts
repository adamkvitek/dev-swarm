import { runCli } from "./cli-runner.js";
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

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "status": "completed" | "blocked",
  "files": [{ "path": string, "content": string }],
  "blockerReason": string | null,
  "notes": string
}`;

export class WorkerAgent {
  private claudeCli: string;

  constructor(private env: Env) {
    this.claudeCli = env.CLAUDE_CLI;
  }

  async execute(
    subtask: Subtask,
    context: {
      techStack: string[];
      previousFeedback?: string;
      otherWorkerOutputs?: Map<string, string>;
    }
  ): Promise<WorkerResult> {
    const promptParts: string[] = [
      WORKER_SYSTEM_PROMPT,
      "",
      `## Subtask: ${subtask.title}`,
      subtask.description,
      `\n## Tech Stack: ${context.techStack.join(", ")}`,
    ];

    if (context.previousFeedback) {
      promptParts.push(
        `\n## Reviewer Feedback (fix these issues):\n${context.previousFeedback}`
      );
    }

    if (context.otherWorkerOutputs?.size) {
      promptParts.push("\n## Other workers' outputs (for context):");
      for (const [id, output] of context.otherWorkerOutputs) {
        promptParts.push(`### ${id}:\n${output}`);
      }
    }

    promptParts.push("\nRespond with the JSON object only.");

    const result = await runCli(this.claudeCli, [
      "--print",
      "--output-format", "text",
      "--dangerously-skip-permissions",
      promptParts.join("\n"),
    ], { timeoutMs: 300_000 });

    if (result.exitCode !== 0) {
      return {
        subtaskId: subtask.id,
        status: "blocked",
        code: "",
        files: [],
        blockerReason: `CLI error: ${result.stderr}`,
      };
    }

    const text = result.stdout.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        subtaskId: subtask.id,
        status: "completed",
        code: text,
        files: [],
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        status: "completed" | "blocked";
        files: Array<{ path: string; content: string }>;
        blockerReason: string | null;
        notes: string;
      };

      return {
        subtaskId: subtask.id,
        status: parsed.status,
        code: parsed.files
          .map((f) => `// ${f.path}\n${f.content}`)
          .join("\n\n"),
        files: parsed.files.map((f) => f.path),
        blockerReason: parsed.blockerReason ?? undefined,
      };
    } catch {
      // If JSON parsing fails, return raw output as code
      return {
        subtaskId: subtask.id,
        status: "completed",
        code: text,
        files: [],
      };
    }
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
