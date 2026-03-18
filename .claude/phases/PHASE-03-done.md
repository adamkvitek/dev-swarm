# Phase 03 — MCP Server + Pipeline Tools
Status: DONE

## Goal
Build an MCP server that gives Claude tools to spawn workers, review code, and manage resources. Claude decides when and how to use them.

## Tasks
- [x] Create job manager (`src/adapter/job-manager.ts`) — async job queue with worker/review lifecycle
- [x] Create HTTP API (`src/adapter/http-api.ts`) — internal bridge for MCP ↔ adapter
- [x] Create MCP server (`src/mcp/server.ts`) with stdio transport + 7 tools
- [x] Create MCP tool definitions (`src/mcp/tools.ts`) with Zod schemas
- [x] Create MCP config generator (`src/adapter/mcp-config.ts`)
- [x] Wire job manager + HTTP API into adapter startup/shutdown
- [x] Update ClaudeSession to accept `--mcp-config` path
- [x] Update DiscordAdapter to inject JobManager, handle job completions
- [x] Update ResourceGuard with activeWorkers/maxWorkers/canSpawnMore
- [x] Add MCP_API_HOST/PORT to env config
- [x] Update system prompt with MCP tool documentation
- [x] Resource governor: enforce MAX_CONCURRENT_WORKERS and MEMORY_CEILING_PCT at spawn time
- [x] Worker completion notifications — synthetic messages piped back to Claude
- [x] Completed job eviction after 1 hour (prevent memory leak)

## Acceptance Criteria
- Claude can spawn workers and reviewers via MCP tools
- Claude can check system resources before deciding to spawn more work
- Worker results flow back to Claude as conversation context
- Resource limits enforced: max 4 concurrent workers, 80% memory ceiling
- Worker completion triggers async notification to Claude session
- All 58 existing tests pass, clean typecheck

## Decisions Made This Phase
- 2026-03-18: MCP server is stateless thin HTTP client; adapter holds all state (see DECISIONS.md)
- 2026-03-18: Raw http.createServer for internal API — no Express needed for ~7 localhost endpoints
