# Phase 01 — Foundation & Discord Pipeline
Status: DONE

## Goal
Get a working Discord bot that accepts tasks, decomposes them via a CTO agent, runs Claude workers, reviews with Codex, and loops until approved.

## Tasks
- [x] Create private GitHub repo
- [x] Set up project structure (package.json, tsconfig, .env, .gitignore)
- [x] Implement CTO agent (task decomposition via Claude CLI)
- [x] Implement Worker agent (code generation via Claude CLI)
- [x] Implement Reviewer agent (code review via Codex CLI)
- [x] Implement Researcher agent (stub — Perplexity API costs extra)
- [x] Implement Pipeline orchestrator (review loop)
- [x] Implement Discord bot (message handling, embeds, session management)
- [x] Write entry point (src/index.ts)
- [x] TypeScript compiles clean
- [x] Write setup guide (SETUP.md)
- [x] Initial commit and push
- [x] Bot connects to Discord and receives messages
- [x] CTO agent spawns Claude CLI and processes requests
- [x] Enable --dangerously-skip-permissions for file access

## Acceptance Criteria — Met
- `npm run build` compiles without errors
- Bot connects to Discord and responds to @mention or !dev
- CTO agent receives requests and spawns Claude CLI
- Pipeline structure supports full review loop

## Decisions Made This Phase
- Dropped OpenClaw — Baptiste warned it's dangerous, not needed for orchestration
- CLI spawning (claude/codex) instead of API SDKs — uses existing subscriptions, no extra API keys
- discord.js directly for the bot — full control over interaction flow
- MAX_REVIEW_ITERATIONS: max 5, default 3 — diminishing returns beyond 3 (OpenSwarm production default)
- Prompts piped via temp files to avoid shell escaping issues
- --dangerously-skip-permissions for agents to access files (run on trusted local machine only)
