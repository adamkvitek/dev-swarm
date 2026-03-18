# Phase 01 — Foundation & Discord Pipeline
Status: ACTIVE

## Goal
Get a working Discord bot that accepts tasks, decomposes them via a CTO agent, runs Claude workers, reviews with Codex, and loops until approved.

## Tasks
- [x] Create private GitHub repo
- [x] Set up project structure (package.json, tsconfig, .env, .gitignore)
- [x] Create OpenClaw skill definition (SKILL.md)
- [x] Implement CTO agent (task decomposition)
- [x] Implement Worker agent (code generation)
- [x] Implement Reviewer agent (Codex code review)
- [x] Implement Researcher agent (Perplexity)
- [x] Implement Pipeline orchestrator (review loop)
- [x] Implement Discord bot (message handling, embeds, session management)
- [x] Write entry point (src/index.ts)
- [ ] Verify TypeScript compiles
- [ ] Write setup guide (OpenClaw + Discord bot creation)
- [ ] Initial commit and push
- [ ] Install dependencies and test locally

## Acceptance Criteria
- `npm run build` compiles without errors
- Bot connects to Discord and responds to `!dev` or @mention
- CTO agent returns clarifying questions or a task plan
- Workers execute subtasks and return code
- Reviewer scores code and returns APPROVE/REVISE
- Review loop iterates up to MAX_REVIEW_ITERATIONS

## Decisions Made This Phase
- Use OpenClaw as the platform (install normally, don't fork) with custom skill for orchestration
- Custom private repo for the orchestration logic only
- Claude (claude-sonnet-4-20250514) for CTO + workers, OpenAI (o3) for reviewer — cross-model review catches blind spots
- Perplexity (sonar-pro) for research agent — avoids burning Claude/OpenAI tokens on search
- discord.js directly for the bot (not relying on OpenClaw's Discord channel yet — can migrate later)
