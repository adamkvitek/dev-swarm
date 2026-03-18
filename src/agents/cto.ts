import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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

const CTO_SYSTEM_PROMPT = `You are a CTO agent that decomposes development tasks.

Given a user request, either ask clarifying questions OR provide a task plan.

Respond ONLY with a JSON object. No markdown, no code fences, no explanation.

If you need clarifications:
{"clarifications_needed": ["question 1", "question 2"], "plan": null}

If the task is clear:
{"clarifications_needed": null, "plan": {"summary": "what this delivers", "subtasks": [{"id": "1", "title": "short title", "description": "what to implement", "dependencies": []}], "techStack": ["tech1"], "decisions": ["decision1"]}}`;

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
    this.conversationContext.push(`User: ${userRequest}`);

    const prompt = `${CTO_SYSTEM_PROMPT}\n\nRequest: ${this.conversationContext.join("\n")}\n\nJSON response:`;

    // Write prompt to temp file to avoid shell escaping issues
    const tmpFile = join(tmpdir(), `cto-${randomUUID()}.txt`);
    await writeFile(tmpFile, prompt, "utf-8");

    console.log(`[CTO] Prompt written to ${tmpFile} (${prompt.length} chars)`);

    try {
      const result = await runCli("bash", [
        "-c",
        `cat "${tmpFile}" | ${this.claudeCli} --print --output-format text --dangerously-skip-permissions`,
      ], { timeoutMs: 600_000 }); // 10 min — reading large repos takes time

      if (result.exitCode !== 0) {
        throw new Error(`CTO agent failed (exit ${result.exitCode}): ${result.stderr}`);
      }

      const text = result.stdout.trim();
      console.log(`[CTO] Response: ${text.slice(0, 200)}...`);
      this.conversationContext.push(`CTO: ${text}`);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`CTO agent returned non-JSON: ${text.slice(0, 200)}`);
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        clarifications_needed: string[] | null;
        plan: TaskPlan | null;
      };

      return {
        clarifications: parsed.clarifications_needed,
        plan: parsed.plan,
      };
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
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
