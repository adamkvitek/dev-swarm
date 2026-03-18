import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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

const WORKER_SYSTEM_PROMPT = `You are a senior developer agent. Implement the subtask below.

Rules:
- Write clean, production-quality code.
- Include error handling and types.
- Follow the tech stack specified.
- If blocked, explain what you need.

Respond ONLY with JSON (no markdown fences):
{"status": "completed"|"blocked", "files": [{"path": "...", "content": "..."}], "blockerReason": null, "notes": "..."}`;

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
        `\n## Reviewer Feedback (fix these):\n${context.previousFeedback}`
      );
    }

    promptParts.push("\nJSON response:");

    // Write prompt to temp file to avoid shell escaping issues
    const tmpFile = join(tmpdir(), `worker-${subtask.id}-${randomUUID()}.txt`);
    await writeFile(tmpFile, promptParts.join("\n"), "utf-8");

    console.log(`[WORKER ${subtask.id}] ${subtask.title} — starting`);

    try {
      const result = await runCli("bash", [
        "-c",
        `cat "${tmpFile}" | ${this.claudeCli} --print --output-format text --dangerously-skip-permissions`,
      ], { timeoutMs: 600_000 }); // 10 min per worker

      if (result.exitCode !== 0) {
        console.log(`[WORKER ${subtask.id}] Failed (exit ${result.exitCode})`);
        return {
          subtaskId: subtask.id,
          status: "blocked",
          code: "",
          files: [],
          blockerReason: `CLI error (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        };
      }

      const text = result.stdout.trim();
      console.log(`[WORKER ${subtask.id}] Completed (${text.length} chars)`);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          subtaskId: subtask.id,
          status: "completed",
          code: text.slice(0, 5000),
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
        return {
          subtaskId: subtask.id,
          status: "completed",
          code: text.slice(0, 5000),
          files: [],
        };
      }
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  }

  async executeParallel(
    subtasks: Subtask[],
    context: { techStack: string[]; previousFeedback?: string }
  ): Promise<WorkerResult[]> {
    console.log(`[WORKERS] Dispatching ${subtasks.length} workers in parallel`);
    const results = await Promise.all(
      subtasks.map((subtask) => this.execute(subtask, context))
    );
    const completed = results.filter((r) => r.status === "completed").length;
    console.log(`[WORKERS] Done: ${completed}/${subtasks.length} completed`);
    return results;
  }
}
