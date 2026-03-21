/**
 * Shared types for the CTO → Worker → Reviewer pipeline.
 *
 * The CTO role is fulfilled by the Claude CLI session directly
 * (via system prompt + MCP tools). These types define the contract
 * between the CTO's task decomposition and the worker/reviewer agents.
 */

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
