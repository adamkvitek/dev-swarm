# Dev Swarm

AI development team orchestrator. Multiple AI models (Claude, Codex, Gemini) work together — writing code in parallel, reviewing anonymously, and selecting the best implementation.

Runs in two modes: **Terminal** (private, no data leaves your machine) or **Discord** (team collaboration).

## How It Works

```
You: "Add JWT auth to /path/my-app. Use council mode."

                    CTO (Claude)
                    breaks it down
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
        Claude        Codex        Gemini
        writes        writes       writes
        code          code         code
        (worktree 1)  (worktree 2) (worktree 3)
            │            │            │
            └────────────┼────────────┘
                         ▼
              Judge picks best implementation
              (anonymized comparison)
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
        Claude        Codex        Gemini
        reviews       reviews      reviews
        (Reviewer A)  (Reviewer B) (Reviewer C)
            │            │            │
            └────────────┼────────────┘
                         ▼
              Cross-rank (who was most thorough?)
                         ▼
              CTO synthesizes final verdict
                         ▼
                 APPROVE → feature branch
                 REVISE → iterate with feedback
```

## Prerequisites

| Requirement | Check | Notes |
|-------------|-------|-------|
| Node.js 22+ | `node --version` | Required |
| Claude CLI | `claude --version` | Primary worker + CTO |
| Codex CLI | `codex --version` | Council worker + reviewer |
| Gemini CLI | `gemini --version` | Council worker + reviewer + multimodal |
| Git | `git --version` | Worktree management |

Not all CLIs are required — the system degrades gracefully. Claude is the minimum.

## Quick Start

```bash
git clone https://github.com/yourname/dev-swarm.git
cd dev-swarm
npm install
cp .env.example .env
```

### Terminal Mode (recommended for private/company data)

No Discord, no tokens, no external services. Everything stays on your machine.

```bash
npm run dev-swarm
```

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Dev Swarm — Terminal Mode
  Memory: 7200MB / 16000MB (45%) | Workers: 0/4
  Type your request. Ctrl+C to exit.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You: Review /Users/adam/projects/my-app for code quality. Use TypeScript standards.

Daskyleion: I'll review your app. Let me check resources and spawn the review council...
[spawns Claude + Codex + Gemini reviewers in parallel]
...
Council verdict: REVISE (avg 6.8/10)
- Reviewer A (ranked #1): Found SQL injection in auth.ts:42
- Reviewer B (ranked #2): Missing error handling in api/users.ts
- Reviewer C (ranked #3): No tests for the payment module
```

### Discord Mode (team collaboration)

1. Create a bot at [Discord Developer Portal](https://discord.com/developers/applications)
   - Enable **Message Content Intent**
   - Permissions: `Send Messages`, `Read Message History`
2. Add `DISCORD_BOT_TOKEN=your-token` to `.env`
3. Run:
```bash
npm run dev    # development (human-readable logs)
npm start      # production (JSON logs)
```

## Usage Examples

### Standard mode (Claude workers, council review)
```
You: Add rate limiting to /Users/adam/projects/api using Express and TypeScript.
```

### Council mode (3 models implement, best picked, then reviewed)
```
You: Add authentication to /Users/adam/projects/api. Use council mode — this is security-critical.
```

### Multimodal (Gemini analyzes images/audio/PDFs)
```
You: Look at the screenshot at /Users/adam/Desktop/bug.png and fix the UI issue in /Users/adam/projects/frontend.
You: Read the spec PDF at /Users/adam/docs/api-spec.pdf and implement the endpoints in /Users/adam/projects/api.
```

### Review existing code
```
You: Review /Users/adam/projects/legacy-app for security issues. Focus on input validation and auth.
```

## Architecture

```
Terminal / Discord
        │
   Claude CLI (CTO — persistent session via --resume)
        │
   MCP Tools ──────────────────────────────────┐
        │                                       │
   spawn_workers ── single model per subtask    │
   spawn_council ── 3 models per subtask        │
   spawn_review ─── council review (3 models)   │
        │                                       │
   Internal HTTP API                            │
        │                                       │
   Job Manager                                  │
    ┌───┼───┐                                   │
 Claude Codex Gemini ← workers in worktrees     │
    └───┼───┘                                   │
   Worktree Manager ← isolated git worktrees    │
   Standards Loader ← language-specific rules   │
   Control Plane ── self-modification safety ───┘
```

| Module | Purpose |
|--------|---------|
| **Adapter** | Transport (Discord or terminal). No business logic. |
| **MCP Server** | Gives Claude tools: spawn_workers, spawn_council, spawn_review, etc. |
| **Job Manager** | Worker/reviewer lifecycle, cleanup, eviction, hard cap (1000 jobs). |
| **Worktree Manager** | Isolated git worktrees per worker, serialized creation, retry cleanup. |
| **Standards Loader** | Detects language from tech stack, injects coding standards + project conventions. |
| **Council Reviewer** | 3-stage review: parallel → anonymized ranking → CTO synthesis. |
| **Council Worker** | Multi-model implementation: fan out → judge → pick best. |
| **Control Plane** | Self-modification guardrails (4-layer defense). |

## Model Strengths

| Model | Best At | Used For |
|-------|---------|----------|
| **Claude** | Architecture, refactoring, reasoning, TypeScript/Python/Go | Workers (primary), CTO, review council |
| **Codex** | Bug detection, logical errors, code analysis | Review council, council workers |
| **Gemini** | **Images**, **audio**, **PDFs**, broad language support | Review council, council workers, multimodal |

Gemini can natively analyze: PNG, JPG, GIF, WEBP, SVG, BMP, MP3, WAV, AIFF, AAC, OGG, FLAC, and PDF files.

## Coding Standards

Workers receive language-specific standards automatically based on the tech stack. 10 languages covered: TypeScript, Python, Go, Rust, Java, C#, C, C++, Swift, Ruby.

**Project conventions always win.** If the target repo has `CONTRIBUTING.md`, `.eslintrc`, `pyproject.toml`, etc., those override our generic standards.

See [SKILL.md](SKILL.md) for the full standards matrix and review checklist.

## Configuration

All defaults auto-detect from your hardware. Override in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | _(none)_ | Required for Discord mode only |
| `MAX_CONCURRENT_WORKERS` | 50% of CPU cores | Max parallel workers |
| `MEMORY_CEILING_PCT` | 85% (macOS) / 80% (Linux/Windows) | Refuse work above this |
| `WORKSPACE_DIR` | `~/dev/swarm-workspace` | Where worktrees live |
| `REVIEW_QUALITY_THRESHOLD` | 8 | Score to APPROVE (1-10) |
| `LOG_LEVEL` | info | debug, info, warn, error |
| `CLAUDE_CLI` / `CODEX_CLI` / `GEMINI_CLI` | claude / codex / gemini | CLI paths |

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev-swarm` | **Terminal mode** — private, no Discord |
| `npm run dev` | Discord mode, human-readable logs |
| `npm start` | Discord mode, production JSON logs |
| `npm run build` | Compile TypeScript |
| `npm test` | Run 155 tests |
| `npm run typecheck` | Type check |
| `npm run lint` | Lint with oxlint |

## Stopping

- **Ctrl+C** — graceful shutdown (finishes work, cleans worktrees)
- **Ctrl+C twice** — immediate kill
- From another terminal: `pkill -f "node dist/index.js"`

## Safety

When agents target this repo's own codebase, four protection layers activate: deterministic path validation, self-repo fingerprinting, prompt restrictions, and CODEOWNERS review requirements. See [SKILL.md](SKILL.md) for details.

## License

MIT
