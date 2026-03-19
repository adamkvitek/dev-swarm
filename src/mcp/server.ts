#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_DEFINITIONS } from "./tools.js";

const API_URL = process.env.DEV_SWARM_API_URL;
const API_TOKEN = process.env.DEV_SWARM_API_TOKEN;
if (!API_URL || !API_TOKEN) {
  // MCP server runs as a child process — use stderr for fatal config errors
  // (pino logger may not be available since this is a standalone entry point)
  process.stderr.write("DEV_SWARM_API_URL and DEV_SWARM_API_TOKEN environment variables are required\n");
  process.exit(1);
}

/**
 * MCP server for dev-swarm.
 *
 * Started by Claude CLI as a child process (stdio transport).
 * Completely stateless — all state lives in the adapter's job manager.
 * Each tool call is a simple HTTP request to the adapter's internal API.
 */

async function apiCall(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `${API_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_TOKEN}`,
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    const errorMsg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(errorMsg);
  }

  return data;
}

const server = new McpServer(
  { name: "dev-swarm", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

// --- spawn_workers ---
server.tool(
  "spawn_workers",
  TOOL_DEFINITIONS.spawn_workers.description,
  TOOL_DEFINITIONS.spawn_workers.inputSchema,
  async (args) => {
    const data = await apiCall("POST", "/jobs/workers", {
      channelId: args.channel_id,
      subtasks: args.subtasks,
      techStack: args.tech_stack,
      repoPath: args.repo_path,
      previousFeedback: args.previous_feedback,
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    };
  },
);

// --- spawn_review ---
server.tool(
  "spawn_review",
  TOOL_DEFINITIONS.spawn_review.description,
  TOOL_DEFINITIONS.spawn_review.inputSchema,
  async (args) => {
    const data = await apiCall("POST", "/jobs/review", {
      channelId: args.channel_id,
      workerJobId: args.worker_job_id,
      taskDescription: args.task_description,
      iteration: args.iteration,
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    };
  },
);

// --- get_job_status ---
server.tool(
  "get_job_status",
  TOOL_DEFINITIONS.get_job_status.description,
  TOOL_DEFINITIONS.get_job_status.inputSchema,
  async (args) => {
    const data = await apiCall("GET", `/jobs/${args.job_id}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    };
  },
);

// --- get_job_result ---
server.tool(
  "get_job_result",
  TOOL_DEFINITIONS.get_job_result.description,
  TOOL_DEFINITIONS.get_job_result.inputSchema,
  async (args) => {
    const data = await apiCall("GET", `/jobs/${args.job_id}/result`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    };
  },
);

// --- list_jobs ---
server.tool(
  "list_jobs",
  TOOL_DEFINITIONS.list_jobs.description,
  TOOL_DEFINITIONS.list_jobs.inputSchema,
  async (args) => {
    const params = new URLSearchParams();
    if (args.channel_id) params.set("channelId", args.channel_id);
    if (args.status) params.set("status", args.status);
    const query = params.toString();
    const path = query ? `/jobs?${query}` : "/jobs";

    const data = await apiCall("GET", path);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    };
  },
);

// --- cancel_job ---
server.tool(
  "cancel_job",
  TOOL_DEFINITIONS.cancel_job.description,
  TOOL_DEFINITIONS.cancel_job.inputSchema,
  async (args) => {
    const data = await apiCall("POST", `/jobs/${args.job_id}/cancel`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    };
  },
);

// --- check_resources ---
server.tool(
  "check_resources",
  TOOL_DEFINITIONS.check_resources.description,
  async () => {
    const data = await apiCall("GET", "/resources");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    };
  },
);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
