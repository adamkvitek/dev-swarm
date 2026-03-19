import { z } from "zod";

/**
 * Tool definitions for the dev-swarm MCP server.
 *
 * Each tool has a name, description, and Zod input schema.
 * The MCP server registers these and dispatches calls to the adapter's HTTP API.
 */

export const TOOL_DEFINITIONS = {
  spawn_workers: {
    description:
      "Spawn parallel worker agents to implement subtasks. Returns a job_id — workers run in the background (5-30 min). You'll be notified when they finish.",
    inputSchema: {
      channel_id: z.string().describe("Discord channel ID for this job"),
      subtasks: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string(),
            dependencies: z.array(z.string()),
          }),
        )
        .describe("Subtasks to implement in parallel"),
      tech_stack: z.array(z.string()).describe("Technologies to use (e.g. ['TypeScript', 'React'])"),
      repo_path: z.string().describe("Absolute path to the target git repository"),
      previous_feedback: z
        .string()
        .optional()
        .describe("Reviewer feedback from a prior iteration, if any"),
    },
  },

  spawn_council: {
    description:
      "Spawn a COUNCIL of workers — multiple AI models (Claude + Gemini) implement each subtask independently in parallel. Use for critical tasks where you want multiple perspectives. Costs ~2-3x more than spawn_workers. Returns a job_id.",
    inputSchema: {
      channel_id: z.string().describe("Discord channel ID for this job"),
      subtasks: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string(),
            dependencies: z.array(z.string()),
          }),
        )
        .describe("Subtasks — each will get implementations from multiple models"),
      tech_stack: z.array(z.string()).describe("Technologies to use"),
      repo_path: z.string().describe("Absolute path to the target git repository"),
      previous_feedback: z
        .string()
        .optional()
        .describe("Reviewer feedback from a prior iteration, if any"),
    },
  },

  spawn_review: {
    description:
      "Spawn a code review using the LLM Council (Claude + Codex + Gemini review anonymously, cross-rank, and synthesize verdict). Returns a job_id.",
    inputSchema: {
      channel_id: z.string().describe("Discord channel ID for this job"),
      worker_job_id: z.string().describe("ID of the completed worker job to review"),
      task_description: z.string().describe("Original task description for review context"),
      iteration: z.number().int().min(1).describe("Review iteration number (1-based)"),
    },
  },

  get_job_status: {
    description: "Check the current status of a job (running, completed, failed, cancelled).",
    inputSchema: {
      job_id: z.string().describe("Job ID to check"),
    },
  },

  get_job_result: {
    description:
      "Get the full result of a completed or failed job. For worker jobs: returns WorkerResult[] with code and files. For review jobs: returns ReviewResult with scores and verdict.",
    inputSchema: {
      job_id: z.string().describe("Job ID to get results for"),
    },
  },

  list_jobs: {
    description: "List all jobs, optionally filtered by channel or status.",
    inputSchema: {
      channel_id: z.string().optional().describe("Filter by Discord channel ID"),
      status: z
        .enum(["running", "completed", "failed", "cancelled"])
        .optional()
        .describe("Filter by job status"),
    },
  },

  cancel_job: {
    description: "Cancel a running job. Workers will be terminated.",
    inputSchema: {
      job_id: z.string().describe("Job ID to cancel"),
    },
  },

  check_resources: {
    description:
      "Check system resources and worker capacity. Use this before spawning workers to see if the system can handle more work.",
    inputSchema: {},
  },
} as const;
