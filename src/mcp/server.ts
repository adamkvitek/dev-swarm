#!/usr/bin/env node
import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import { isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
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
  { name: "dev-swarm", version: "0.1.0" },
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

// --- spawn_council ---
server.tool(
  "spawn_council",
  TOOL_DEFINITIONS.spawn_council.description,
  TOOL_DEFINITIONS.spawn_council.inputSchema,
  async (args) => {
    const data = await apiCall("POST", "/jobs/council", {
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

// --- get_time (local) ---
server.tool(
  "get_time",
  TOOL_DEFINITIONS.get_time.description,
  TOOL_DEFINITIONS.get_time.inputSchema,
  async (args) => {
    const now = new Date();
    let formatted: string;
    try {
      formatted = now.toLocaleString("en-US", {
        timeZone: args.timezone ?? undefined,
        dateStyle: "full",
        timeStyle: "long",
      });
    } catch {
      formatted = now.toISOString();
    }
    return {
      content: [{ type: "text" as const, text: `${formatted}\nISO: ${now.toISOString()}` }],
    };
  },
);

// --- read_file (local, sandboxed) ---
const home = os.homedir();
const BLOCKED_PREFIXES = [
  "/etc", "/var", "/proc", "/sys", "/dev", "/boot", "/sbin", "/usr",
  `${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`, `${home}/.config`,
  `${home}/.netrc`, `${home}/.npmrc`,
];

server.tool(
  "read_file",
  TOOL_DEFINITIONS.read_file.description,
  TOOL_DEFINITIONS.read_file.inputSchema,
  async (args) => {
    let filePath = resolve(args.path);

    if (!isAbsolute(filePath)) {
      return { content: [{ type: "text" as const, text: "Error: path must be absolute" }], isError: true };
    }

    // Resolve symlinks to prevent bypass of blocked prefixes
    try {
      filePath = await realpath(filePath);
    } catch {
      // realpath throws if file doesn't exist — let the stat check below handle that
    }

    for (const prefix of BLOCKED_PREFIXES) {
      if (filePath === prefix || filePath.startsWith(prefix + "/")) {
        return { content: [{ type: "text" as const, text: `Error: cannot read system directory: ${prefix}` }], isError: true };
      }
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return { content: [{ type: "text" as const, text: "Error: path is not a file" }], isError: true };
      }
      if (info.size > 5 * 1024 * 1024) {
        return { content: [{ type: "text" as const, text: "Error: file is larger than 5MB" }], isError: true };
      }
      const raw = await readFile(filePath, "utf-8");
      const maxLines = args.max_lines ?? 500;
      const lines = raw.split("\n");
      const truncated = lines.length > maxLines;
      const output = lines.slice(0, maxLines).join("\n");
      const suffix = truncated ? `\n\n... (truncated: ${lines.length} total lines, showing first ${maxLines})` : "";
      return { content: [{ type: "text" as const, text: output + suffix }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error reading file: ${msg}` }], isError: true };
    }
  },
);

// --- run_command (local, allowlisted) ---
const ALLOWED_COMMANDS = new Set([
  "git", "ls", "cat", "wc", "head", "tail", "find", "tree", "npm", "date", "pwd", "which", "echo",
]);

function validateCommand(raw: string): { exe: string; args: string[] } | string {
  const parts = raw.trim().split(/\s+/);
  const exe = parts[0];
  const args = parts.slice(1);

  if (!exe || !ALLOWED_COMMANDS.has(exe)) {
    return `Command '${exe}' is not in the allowlist. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}`;
  }

  // git: only allow read-only subcommands
  if (exe === "git") {
    const sub = args[0];
    const safeGitSubs = new Set([
      "status", "log", "diff", "branch", "show", "ls-files",
      "rev-parse", "merge-base", "tag", "stash", "remote", "worktree",
    ]);
    if (!sub || !safeGitSubs.has(sub)) {
      return `git subcommand '${sub}' is not allowed. Allowed: ${[...safeGitSubs].join(", ")}`;
    }
    // Further restrict multi-word subcommands
    if (sub === "stash" && args[1] !== "list") {
      return "Only 'git stash list' is allowed";
    }
    if (sub === "remote" && args[1] !== "-v") {
      return "Only 'git remote -v' is allowed";
    }
    if (sub === "worktree" && args[1] !== "list") {
      return "Only 'git worktree list' is allowed";
    }
  }

  // npm: only allow safe subcommands
  if (exe === "npm") {
    const sub = args[0];
    const safeNpmSubs = new Set(["test", "ls", "outdated", "audit", "ci"]);
    const safeNpmRunScripts = new Set(["typecheck", "lint", "build", "test"]);
    if (!sub || !safeNpmSubs.has(sub)) {
      // Allow "npm run <script>" only for allowlisted scripts
      if (sub === "run") {
        const script = args[1];
        if (!script || !safeNpmRunScripts.has(script)) {
          return `npm run script '${script}' is not allowed. Allowed: npm run ${[...safeNpmRunScripts].join(", npm run ")}`;
        }
      } else if (sub === "install" && args[1] === "--dry-run") {
        // npm install --dry-run is safe
      } else {
        return `npm subcommand '${sub}' is not allowed. Allowed: ${[...safeNpmSubs].join(", ")}, run [${[...safeNpmRunScripts].join("|")}], install --dry-run`;
      }
    }
  }

  // Reject shell metacharacters that could enable injection
  const dangerous = /[;&|`$(){}!<>\\]/;
  for (const arg of args) {
    if (dangerous.test(arg)) {
      return `Argument '${arg}' contains shell metacharacters. For safety, arguments must not include: ; & | \` $ ( ) { } ! < > \\`;
    }
  }

  // Block path arguments to file-reading commands that point at sensitive dirs.
  // This prevents `cat /etc/passwd` or `head ~/.ssh/id_rsa` from bypassing
  // the read_file sandbox.
  const FILE_READING_COMMANDS = new Set(["cat", "head", "tail", "ls", "find"]);
  if (FILE_READING_COMMANDS.has(exe)) {
    for (const arg of args) {
      if (arg.startsWith("-")) continue; // skip flags
      const resolved = resolve(arg);
      for (const prefix of BLOCKED_PREFIXES) {
        if (resolved === prefix || resolved.startsWith(prefix + "/")) {
          return `Path '${arg}' is blocked. Cannot access system/sensitive directories.`;
        }
      }
    }
  }

  return { exe, args };
}

server.tool(
  "run_command",
  TOOL_DEFINITIONS.run_command.description,
  TOOL_DEFINITIONS.run_command.inputSchema,
  async (args) => {
    const parsed = validateCommand(args.command);
    if (typeof parsed === "string") {
      return { content: [{ type: "text" as const, text: `Error: ${parsed}` }], isError: true };
    }

    const cwd = args.cwd ? resolve(args.cwd) : undefined;
    if (cwd) {
      for (const prefix of BLOCKED_PREFIXES) {
        if (cwd === prefix || cwd.startsWith(prefix + "/")) {
          return { content: [{ type: "text" as const, text: `Error: cannot run in system directory: ${prefix}` }], isError: true };
        }
      }
    }

    return new Promise((resolvePromise) => {
      execFile(parsed.exe, parsed.args, {
        cwd,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number }).code;
          const output = [stdout, stderr, `Exit code: ${code ?? "unknown"}`].filter(Boolean).join("\n");
          resolvePromise({ content: [{ type: "text" as const, text: output || err.message }], isError: true });
          return;
        }
        const output = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
        resolvePromise({ content: [{ type: "text" as const, text: output }] });
      });
    });
  },
);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
