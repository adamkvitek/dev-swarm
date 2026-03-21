# Dev Swarm

A multi-model AI development team. You describe what to build, point it at a repository, and it coordinates Claude, Codex, and Gemini to implement, review, and deliver the code.

Runs entirely on local CLI tools (Claude Code, Codex CLI, Gemini CLI). Uses your existing subscriptions.

> 100% vibe-coded. The agents wrote the code, the tests, the docs, and this README.

```
You: "Add JWT auth to ~/projects/my-app"

                    CTO (Claude)
                    breaks it down
                         |
            +------------+------------+
            v            v            v
        Claude        Codex        Gemini
        writes        writes       writes
        code          code         code
        (worktree 1)  (worktree 2) (worktree 3)
            |            |            |
            +------------+------------+
                         v
              Judge picks best implementation
              (anonymized comparison)
                         |
            +------------+------------+
            v            v            v
        Claude        Codex        Gemini
        reviews       reviews      reviews
            |            |            |
            +------------+------------+
                         v
              Cross-rank, synthesize verdict
                         v
                 APPROVE -> feature branch
                 REVISE  -> iterate with feedback
```

Works in two modes: **headless** (Claude Code + MCP tools, fully local) or **Discord** (collaborative bot for teams).

## Quick start

```bash
git clone https://github.com/adamkvitek/dev-swarm.git
cd dev-swarm
npm install
npm run dev-swarm    # launches server + Claude Code with MCP tools
```

Claude opens with access to the swarm tools. Ask it to build something.

## How it works

A **CTO agent** (Claude) takes your request and breaks it into subtasks. **Worker agents** implement each subtask in isolated git worktrees. They read existing code, write files, and run tests. A **review council** (Claude + Codex + Gemini) reviews the output anonymously, cross-ranks each other, and produces a verdict.

If the review says REVISE, workers get the feedback and try again. If APPROVE, changes land on a feature branch.

### Concepts

- **Workers**: AI agents that write code in isolated git worktrees. They can't conflict with each other.
- **Council mode**: Multiple models implement the same task. A judge picks the best result. Use for critical code. Costs ~3x resources.
- **Review council**: Three models review anonymously, cross-rank for thoroughness, and the CTO synthesizes the final verdict.
- **Standards**: Workers receive language-specific coding standards (10 languages supported) and follow the target repo's conventions.

### Modes

**Headless (recommended)**: Claude Code with MCP tools. Everything stays local.

```bash
npm run dev-swarm
```

**Discord**: Team collaboration. Claude responds to @mentions with live-streaming responses.

```bash
# Set DISCORD_BOT_TOKEN in .env first

npm run dev     # development (pretty logs)
npm start       # production (JSON logs)
```

## Prerequisites

| Tool | Check | Required? |
|------|-------|-----------|
| Node.js 22+ | `node --version` | Yes |
| Claude CLI | `claude --version` | Yes |
| Codex CLI | `codex --version` | For council mode |
| Gemini CLI | `gemini --version` | For council mode |
| Git | `git --version` | Yes |

Not all CLIs are needed. The system works with fewer models available. Claude is the minimum.

For detailed setup instructions (including Discord bot configuration), see [SETUP.md](SETUP.md).

## Configuration

Defaults are auto-detected from your hardware. Override in `.env`:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | | Required for Discord mode only |
| `MAX_CONCURRENT_WORKERS` | 75% of CPU cores (min 2) | Max parallel worker agents |
| `MEMORY_CEILING_PCT` | 92% | Refuse new work above this threshold |
| `REVIEW_QUALITY_THRESHOLD` | 8 | Score (1-10) needed to approve |
| `WORKSPACE_DIR` | `~/dev/swarm-workspace` | Where git worktrees are created |
| `LOG_LEVEL` | info | debug, info, warn, error |
| `CLAUDE_CLI` / `CODEX_CLI` / `GEMINI_CLI` | claude / codex / gemini | CLI executable paths |

See [.env.example](.env.example) for all options.

## Architecture

```
src/
├── index.ts              # Discord mode entry point
├── dev-swarm.ts          # Headless mode (server + Claude Code)
├── serve.ts              # Headless server only
├── logger.ts             # Pino structured logging
├── adapter/
│   ├── discord-adapter.ts  # Discord <> Claude CLI bridge
│   ├── http-api.ts         # Internal API (MCP <> job manager)
│   ├── job-manager.ts      # Worker/reviewer lifecycle
│   ├── resource-guard.ts   # Memory + CPU capacity checks
│   ├── channel-mutex.ts    # Per-channel message serialization
│   ├── mcp-config.ts       # MCP config generation
│   └── validation.ts       # Input validation
├── agents/
│   ├── worker.ts           # Claude worker agent
│   ├── council-worker.ts   # Multi-model council worker
│   ├── reviewer.ts         # Single-model reviewer
│   ├── council-reviewer.ts # 3-stage council review
│   ├── cto.ts              # CTO planning agent
│   ├── cli-runner.ts       # CLI subprocess runner
│   ├── schemas.ts          # Zod schemas for CLI responses
│   ├── shared.ts           # Shared prompts and utilities
│   └── standards-loader.ts # Language-specific coding standards
├── config/
│   └── env.ts              # Environment config (Zod validation)
├── mcp/
│   ├── server.ts           # MCP server (stdio transport)
│   └── tools.ts            # Tool definitions
├── workspace/
│   ├── worktree-manager.ts # Git worktree lifecycle
│   └── control-plane.ts    # Self-modification safety
└── streaming/              # Discord live token streaming (NDJSON)
prompts/
├── system.md               # CTO system prompt
├── code-standards.md       # Universal coding standards
├── review-checklist.md     # 35-item review checklist
└── standards/              # Per-language standards (10 languages)
```

## Safety

When agents target this repo's own codebase, four protection layers activate:

1. **Deterministic path validation**: blocks auto-merge of infrastructure files
2. **Self-repo fingerprinting**: detects when workers target the bot itself
3. **Prompt restrictions**: workers get explicit rules about protected paths
4. **CODEOWNERS**: requires human review for all infrastructure changes

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev-swarm` | Headless mode (server + Claude Code) |
| `npm run dev` | Discord mode, human-readable logs |
| `npm start` | Discord mode, production JSON logs |
| `npm run build` | Compile TypeScript |
| `npm test` | Run tests (vitest) |
| `npm run typecheck` | Type check |
| `npm run lint` | Lint with oxlint |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
