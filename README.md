# Dev Swarm

AI development team orchestrator. Coordinates parallel AI worker agents to build software — with cross-model code review (Codex), isolated git worktrees, and enforced coding standards.

Runs in two modes: **Discord bot** for team collaboration, or **Terminal** for private/company work.

## How It Works

1. You give the bot a task and a repo path (via Discord or terminal)
2. Claude (the CTO) breaks the task into subtasks
3. Parallel worker agents execute in isolated git worktrees — reading real code, writing files, running tests
4. A reviewer agent (Codex/o3) reviews the output with full filesystem access
5. If approved, changes are merged to a feature branch. If not, workers iterate with feedback.

Workers receive language-specific coding standards (TypeScript, Python, Go, Rust, Java, C#, C/C++, Swift, Ruby) and a 35-point review checklist covering OWASP security, memory safety, and AI anti-patterns.

## Prerequisites

| Requirement | Check | Install |
|-------------|-------|---------|
| Node.js 22+ | `node --version` | [nodejs.org](https://nodejs.org) |
| Claude CLI | `claude --version` | [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) |
| Codex CLI | `codex --version` | [Codex GitHub](https://github.com/openai/codex) |
| Git | `git --version` | Already installed on most systems |

Discord bot token is only needed for Discord mode — terminal mode works without it.

## Quick Start

```bash
git clone https://github.com/adamkvitek/dev-swarm.git
cd dev-swarm
npm install
cp .env.example .env
```

### Terminal Mode (no Discord, private data stays local)

No setup needed beyond the prerequisites. No tokens, no accounts.

```bash
npm run cli
```

You get an interactive session:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Dev Swarm — Terminal Mode
  Memory: 7200MB / 16000MB (45%) | Workers: 0/4
  Type your request. Ctrl+C to exit.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You: Review /Users/adam/projects/my-app for code quality. Use TypeScript standards.
```

Use this mode when:
- Working with company/private code
- You don't want data going through Discord
- You want a quick local session
- Testing the pipeline

### Discord Mode (team collaboration)

#### 1. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. **New Application** → name it (e.g. "Daskyleion")
3. **Bot** tab:
   - Click **Reset Token** → copy the token
   - Enable **Message Content Intent** (required to read messages)
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`
   - Copy the generated URL → open it → add the bot to your server

#### 2. Configure

Edit `.env` and add your bot token:

```
DISCORD_BOT_TOKEN=your-bot-token-here
```

#### 3. Run

```bash
# Development (human-readable logs)
npm run dev

# Production (JSON logs)
npm run build && npm start
```

#### 4. Use

@mention the bot in Discord:

```
@bot Review the code quality of /Users/adam/projects/my-api. Focus on error handling.
@bot Add rate limiting to /Users/adam/projects/my-api using TypeScript and Express.
@bot Fix the authentication bug in /Users/adam/projects/my-app. The login endpoint returns 500.
```

## Configuration

All settings have sensible defaults derived from your hardware. Override in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | _(none)_ | Required for Discord mode only |
| `MAX_CONCURRENT_WORKERS` | 50% of CPU cores | Max parallel worker agents |
| `MEMORY_CEILING_PCT` | 85% (macOS) / 80% (Linux) | Refuse new work above this % of RAM |
| `WORKSPACE_DIR` | `~/dev/swarm-workspace` | Where git worktrees are created |
| `REVIEW_QUALITY_THRESHOLD` | 8 | Score needed to APPROVE (1-10) |
| `MAX_REVIEW_ITERATIONS` | 3 | Max review-revise cycles |
| `LOG_LEVEL` | info | Pino log level (debug, info, warn, error) |
| `CLAUDE_CLI` | claude | Path to Claude CLI binary |
| `CODEX_CLI` | codex | Path to Codex CLI binary |

## Architecture

```
Terminal / Discord
        ↓
   Claude CLI (persistent sessions via --resume)
        ↓
   MCP Tools (spawn_workers, spawn_review, etc.)
        ↓
   Internal HTTP API
        ↓
   Job Manager
    ↙        ↘
Workers       Reviewer
(Claude CLI)  (Codex CLI)
in worktrees  in worktree
```

- **Adapter** — thin transport (Discord or terminal). No business logic.
- **MCP Server** — gives Claude tools to spawn workers, reviews, check resources.
- **Job Manager** — owns worker/reviewer lifecycle, cleanup, eviction.
- **Worktree Manager** — isolated git worktrees per worker, serialized creation, retry cleanup.
- **Standards Loader** — detects language from tech stack, injects coding standards + project conventions.
- **Control Plane** — self-modification guardrails when agents target this repo.

## Safety

When agents target dev-swarm's own codebase, four layers of protection activate:

1. **Deterministic path validation** — blocks auto-merge of control plane files
2. **Self-repo detection** — fingerprints the target repo
3. **Prompt restrictions** — workers warned about protected paths
4. **CODEOWNERS** — requires human review for all infrastructure paths

## Coding Standards

Workers automatically receive coding standards based on the `tech_stack` parameter:

| Language | Standards file |
|----------|---------------|
| TypeScript / JavaScript / React / Node.js | `prompts/standards/typescript.md` |
| Python / Django / Flask / FastAPI | `prompts/standards/python.md` |
| Go | `prompts/standards/go.md` |
| Rust | `prompts/standards/rust.md` |
| Java / Spring / Kotlin | `prompts/standards/java.md` |
| C# / .NET | `prompts/standards/csharp.md` |
| C | `prompts/standards/c.md` |
| C++ / CMake / Qt | `prompts/standards/cpp.md` |
| Swift / SwiftUI / iOS | `prompts/standards/swift.md` |
| Ruby / Rails | `prompts/standards/ruby.md` |

**Project conventions override generic standards.** If the target repo has a `CONTRIBUTING.md`, `.eslintrc`, `pyproject.toml`, or other convention files, those are loaded first and take priority.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run cli` | **Terminal mode** — interactive REPL, no Discord |
| `npm run dev` | Discord mode with human-readable pino-pretty logs |
| `npm start` | Discord mode, production (JSON logs) |
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Run tests (vitest) |
| `npm run lint` | Lint with oxlint |

## Stopping the Bot

- **Ctrl+C** — graceful shutdown (finishes in-flight work, cleans worktrees)
- **Ctrl+C twice** — immediate kill
- From another terminal: `pkill -f "node dist/index.js"` and `rm -rf ~/dev/swarm-workspace/worker-*`

## Tests

```bash
npm test
```

155 tests covering: input validation, control plane safety, resource management, channel serialization, CLI JSON parsing, HTTP API integration, and env configuration.

## License

MIT
