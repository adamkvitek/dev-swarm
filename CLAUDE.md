# Dev Swarm — Agent Instructions

## Quick reference

```bash
npm install          # install dependencies
npm test             # vitest — all unit/integration tests
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint
npm run dev          # Discord bot + hot reload + pretty logs
npm run start        # Discord bot — compiled JS, production logs
npm run serve        # headless HTTP API only (no Discord)
npm run dev-swarm    # starts serve + launches Claude Code with MCP tools
npm run test:e2e     # Playwright Discord UX tests (needs auth setup first)
```

## Architecture

```
User (Discord / CLI)
  │
  ▼
DiscordAdapter (src/adapter/discord-adapter.ts)
  │  Bridges Discord ↔ Claude CLI via streaming NDJSON
  │  One persistent session per channel (--resume)
  │
  ├── StreamingClaudeSession (src/streaming/streaming-cli.ts)
  │     Spawns `claude --print --output-format stream-json`
  │     Parses NDJSON, fires callbacks: onTextDelta, onToolUseStart, onToolUseEnd
  │
  ├── DiscordStreamHandler (src/streaming/discord-handler.ts)
  │     Buffers text deltas, flushes to Discord every 1.5s via message edits
  │     Handles 2000-char splits, rate limit retries
  │
  ├── ResourceGuard (src/adapter/resource-guard.ts)
  │     Memory + worker capacity checks, OS-aware (macOS vm_stat, Linux /proc/meminfo)
  │     State transitions: warns on constraint, notifies on recovery
  │
  └── JobManager (src/adapter/job-manager.ts)
        Owns worker/reviewer lifecycle for MCP-spawned jobs
        Workers run in isolated git worktrees (src/workspace/worktree-manager.ts)

MCP Server (src/mcp/server.ts + src/mcp/tools.ts)
  │  stdio-based MCP server — Claude CLI connects via --mcp-config
  │  Proxies tool calls to the HTTP API
  │
  └── HttpApi (src/adapter/http-api.ts)
        Internal REST API on localhost:9847
        spawn_workers, spawn_review, get_job_result, check_resources, etc.
```

## Key directories

| Path | What |
|------|------|
| `src/adapter/` | Discord adapter, HTTP API, job manager, resource guard, channel mutex |
| `src/agents/` | Worker agent, reviewer, council worker/reviewer, CLI runner, CTO prompt |
| `src/streaming/` | Streaming CLI session, Discord stream handler, session manager |
| `src/config/` | Env config with Zod validation, hardware auto-detection |
| `src/mcp/` | MCP stdio server, tool definitions |
| `src/workspace/` | Git worktree manager, control plane safety guardrails |
| `prompts/` | System prompt, coding standards per language, review checklist |
| `tests/e2e/` | Playwright Discord UX tests |

## Code conventions

- **TypeScript** with `strict: true`. No `any` — use `unknown` and narrow.
- **Logging**: structured via pino — `log.adapter.info(...)`, `log.jobMgr.info(...)`. Never `console.log` in src/.
- **Validation**: Zod at system boundaries (env vars, API input). Trust internal types.
- **Imports**: `.js` extensions required (NodeNext module resolution).
- **Tests**: vitest, colocated in `__tests__/` directories. Playwright for e2e in `tests/e2e/`.
- **Commits**: conventional commits — `feat(scope):`, `fix(scope):`, `refactor(scope):`.

## Entry points

| Command | Entry | What it does |
|---------|-------|-------------|
| `npm run dev` | `src/index.ts` | Full Discord bot + HTTP API + MCP config generation |
| `npm run start` | `dist/index.js` | Same, compiled JS, structured JSON logs |
| `npm run serve` | `src/serve.ts` | Headless: HTTP API + MCP config only, no Discord |
| `npm run dev-swarm` | `src/dev-swarm.ts` | Starts serve, then launches Claude Code with MCP tools |

## Environment

Copy `.env.example` to `.env`. Only `DISCORD_BOT_TOKEN` is required for Discord mode.
Resource limits auto-detect from hardware. See `.env.example` for all options.

## Testing

```bash
npm test                    # all vitest tests (unit + integration)
npm test -- --watch         # watch mode
npm run test:e2e:setup      # one-time: save Discord auth for Playwright
DISCORD_TEST_CHANNEL_URL=URL DISCORD_BOT_NAME=NAME npm run test:e2e  # Playwright Discord UX tests
```

## Multi-model agents

The swarm uses three AI models via their CLIs:
- **Claude** (`claude`) — primary worker, CTO, review council
- **Codex** (`codex`) — review council, council workers
- **Gemini** (`gemini`) — review council, council workers, multimodal (images/audio/PDF)

Workers receive language-specific coding standards from `prompts/standards/`.
Review uses a 3-stage anonymized council process (see `prompts/system.md`).

## Safety guardrails

When agents target THIS repository:
1. Deterministic path validation blocks auto-merge of control plane files
2. Self-repo detection fingerprints the target repo
3. Prompt restrictions warn workers about protected paths
4. CODEOWNERS requires human review for infrastructure changes
