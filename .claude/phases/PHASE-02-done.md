# Phase 02 — Claude-native Discord Adapter
Status: DONE

## Goal
Replace the custom state machine + intent classifier with a thin adapter that pipes Discord messages to Claude CLI. Claude IS the bot.

## Tasks
- [x] Create `src/adapter/discord-adapter.ts` — thin bridge between Discord gateway and Claude CLI
- [x] Create `src/adapter/channel-mutex.ts` — per-channel message serialization (prevents race conditions)
- [x] Create `src/adapter/resource-guard.ts` — basic memory/CPU check before processing
- [x] Update `src/index.ts` — new entry point using adapter instead of old DiscordBot
- [x] Update `src/config/env.ts` — add SYSTEM_PROMPT_PATH, MAX_MESSAGE_AGE_MS, MEMORY_CEILING_PCT
- [x] System prompt file for Daskyleion personality (`prompts/system.md`)
- [x] Message age filter — ignore messages older than 60s on startup/reconnect
- [x] Reuse `src/agents/claude-session.ts` for per-channel persistent sessions
- [x] Keep old files in place (don't delete yet) — remove in Phase 3

## Acceptance Criteria
- Bot responds to @mentions on Discord using Claude directly (no intent classification)
- Conversation memory persists within a channel session (via --resume)
- Messages are serialized per channel — no concurrent processing race conditions
- Messages older than 60s are ignored (prevents the startup flood)
- Processing refuses to start when system memory > 80%
- Old DiscordBot class is not imported or used (but file still exists)
- `npx tsc --noEmit` passes

## Decisions Made This Phase
- Kept `--dangerously-skip-permissions` on Claude sessions (same as old CTO agent). Will revisit when MCP tools provide scoped permissions in Phase 2.
- System prompt loaded from file (not hardcoded) so it can be iterated without code changes.
- Default MAX_CONCURRENT_WORKERS lowered from 5 to 4 (50% of 8 cores per DECISIONS.md).
- Resource guard uses `os.freemem()` — simple and cross-platform. More granular per-process tracking deferred to Phase 2.
