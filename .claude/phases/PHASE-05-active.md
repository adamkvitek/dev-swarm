# Phase 05 — Hardening, Security, Tests & Portability
Status: ACTIVE

## Goal
Make the system safe, tested, portable, and robust — addressing all HIGH findings from the codebase analysis before scaling further.

## Tasks

### Security Fixes
- [x] Validate `repoPath`: must be absolute, canonicalized, no traversal
- [x] Sanitize subtask titles/descriptions: length limits, no template injection
- [x] Sanitize git branch names: alphanumeric + hyphens/slashes only
- [x] Add Zod schemas for all JSON parsed from Claude CLI
- [x] Add per-channel rate limiting on job creation (5 jobs/min/channel)

### Dynamic Resource Detection & Portability
- [x] Auto-detect CPU cores and total RAM at startup
- [x] Default: 50% of CPU cores for workers, 50% of RAM as memory ceiling
- [x] Remove hardcoded resource defaults — derived from hardware unless overridden
- [x] First-run experience: announces detected config in Discord on first message

### Code Quality & Duplication
- [x] Extract `runJob<T>` template method (eliminated 80% duplication)
- [x] Use Map<subtaskId, WorktreeInfo> instead of fragile array index coupling
- [x] Narrow Job interface: discriminated union (WorkerJob | ReviewJob)

### Test Coverage (97 new tests, 155 total)
- [x] `src/config/env.ts` — 9 tests
- [x] `src/workspace/control-plane.ts` — 20 tests
- [x] `src/adapter/resource-guard.ts` — 11 tests
- [x] `src/adapter/channel-mutex.ts` — 5 tests
- [x] `src/adapter/validation.ts` — 26 tests
- [x] `src/agents/schemas.ts` — 15 tests
- [x] `src/adapter/http-api.ts` — 11 tests

### Reliability & Resource Management
- [x] Job map hard cap (1000) with oldest-first eviction
- [x] Worktree cleanup retry with backoff (10s, 30s, 2min)
- [x] Wrap eviction timer callback in try-catch
- [x] Health check endpoint: GET /health (no auth)
- [x] Graceful shutdown: ordered cleanup, double-Ctrl+C protection

### Production Readiness
- [x] Discord rate limiting: sendWithRateLimit() with 429 backoff
- [x] Error recovery: auto-retry session before resetting
- [ ] Structured JSON logging (requires dependency decision — deferred to Phase 06)

## Acceptance Criteria
- [x] All 3 HIGH security issues fixed with tests
- [x] System auto-detects hardware and configures resource limits
- [x] Test coverage on 7 critical modules (97 new tests)
- [x] No unbounded Map growth — hard caps enforced
- [x] Failed worktree cleanup retried with backoff
- [x] Graceful shutdown with ordered cleanup
- [x] Health check endpoint available
- [x] Discord rate limit handling with backoff
- [x] Session error recovery before reset
- [x] First-run hardware announcement in Discord

## Decisions Made This Phase
- 2026-03-19: Input validation is deterministic — ValidationError returns 400
- 2026-03-19: repoPath blocks system dirs (/etc, /proc, /var, /sys, /dev, /boot, /sbin)
- 2026-03-19: Dynamic resource defaults: 50% CPU cores for workers, 50% RAM ceiling
- 2026-03-19: Job map hard cap at 1000 with oldest-completed-first eviction
- 2026-03-19: Zod schemas replace all `as` casts for CLI JSON parsing
- 2026-03-19: Worktree cleanup retries 3 times with 10s/30s/2min backoff
- 2026-03-19: Rate limit: 5 job creations per channel per minute
- 2026-03-19: Job interface narrowed to discriminated union (WorkerJob | ReviewJob)
- 2026-03-19: Structured logging deferred — needs dependency choice (pino vs winston), fits Phase 06
