# Dev Swarm

AI development team orchestrator. A Discord bot powered by Claude that coordinates parallel worker agents to build software — with cross-model code review (Codex), isolated git worktrees, and enforced coding standards.

## How It Works

1. You @mention the bot on Discord with a task and a repo path
2. Claude (the CTO) breaks the task into subtasks
3. Parallel worker agents execute in isolated git worktrees — reading real code, writing files, running tests
4. A reviewer agent (Codex/o3) reviews the output with full filesystem access
5. If approved, changes are merged to a feature branch. If not, workers iterate with feedback.

Workers receive language-specific coding standards (TypeScript, Python, Go, Rust, Java, C#, C/C++, Swift, Ruby) and a 35-point review checklist covering OWASP security, memory safety, and AI anti-patterns.

## Prerequisites

- **Node.js 22+** — `node --version`
- **Claude CLI** — `claude --version` ([install](https://docs.anthropic.com/en/docs/claude-code))
- **Codex CLI** — `codex --version` ([install](https://github.com/openai/codex))
- **Discord Bot** — token from [Discord Developer Portal](https://discord.com/developers/applications)
- **Git** — for worktree management

## Setup

### 1. Clone and install

```bash
git clone https://github.com/adamkvitek/dev-swarm.git
cd dev-swarm
npm install
```

### 2. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. **New Application** — name it (e.g. "Daskyleion")
3. **Bot** tab:
   - Click **Reset Token** → copy the token
   - Enable **Message Content Intent** (required to read messages)
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`
   - Copy the generated URL → open it → add the bot to your server

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set:

```
DISCORD_BOT_TOKEN=your-bot-token-here
```

That's the only required value. Everything else has sensible defaults derived from your hardware (CPU cores, RAM).

Optional overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT_WORKERS` | 50% of CPU cores | Max parallel worker agents |
| `MEMORY_CEILING_PCT` | 50 | Refuse new work above this % of RAM |
| `WORKSPACE_DIR` | `~/dev/swarm-workspace` | Where git worktrees are created |
| `REVIEW_QUALITY_THRESHOLD` | 8 | Score needed to APPROVE (1-10) |
| `MAX_REVIEW_ITERATIONS` | 3 | Max review-revise cycles |
| `LOG_LEVEL` | info | Pino log level (debug, info, warn, error) |
| `CLAUDE_CLI` | claude | Path to Claude CLI binary |
| `CODEX_CLI` | codex | Path to Codex CLI binary |

### 4. Run

```bash
# Development (human-readable logs)
npm run dev

# Production (JSON logs)
npm run build && npm start
```

## Usage

@mention the bot in Discord:

```
@bot Add JWT authentication to /Users/adam/projects/my-app
```

The bot will:
1. Ask clarifying questions if needed
2. Present a plan and wait for your approval
3. Spawn workers in isolated git worktrees
4. Review the output with Codex
5. Report results — including the feature branch name on approval

### Example commands

```
@bot Review the code quality of /Users/adam/projects/my-api. Focus on error handling.
@bot Add rate limiting to /Users/adam/projects/my-api using TypeScript and Express.
@bot Fix the authentication bug in /Users/adam/projects/my-app. The login endpoint returns 500.
```

### System commands

- **Cancel a running job** — the bot tells you the job ID; ask it to cancel
- **Check status** — ask the bot what's running

## Architecture

```
Discord ←→ Adapter ←→ Claude CLI (with --resume sessions)
                          ↓
                    MCP Tools (spawn_workers, spawn_review, etc.)
                          ↓
                    Internal HTTP API
                          ↓
                    Job Manager
                     ↙        ↘
              Workers          Reviewer
           (Claude CLI)      (Codex CLI)
           in worktrees      in worktree
```

- **Adapter** — thin transport between Discord and Claude CLI. No business logic.
- **MCP Server** — gives Claude tools to spawn workers, reviews, check resources.
- **Job Manager** — owns worker/reviewer lifecycle, cleanup, eviction.
- **Worktree Manager** — isolated git worktrees per worker, serialized creation, retry cleanup.
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
| `npm run dev` | Run in dev mode with pino-pretty logs |
| `npm start` | Run production build |
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Run tests (vitest) |
| `npm run lint` | Lint with oxlint |

## Tests

```bash
npm test
```

155 tests covering: input validation, control plane safety, resource management, channel serialization, CLI JSON parsing, HTTP API integration, and env configuration.

## License

UNLICENSED — Private project.
