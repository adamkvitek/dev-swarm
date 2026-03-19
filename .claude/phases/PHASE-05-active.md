# Phase 05 — Hardening, Security, Tests & Portability
Status: ACTIVE

## Goal
Make the system safe, tested, portable, and robust — addressing all HIGH findings from the codebase analysis before scaling further.

## Tasks

### Security Fixes (HIGH priority)
- [x] Validate `repoPath`: must be absolute, canonicalized, no traversal (http-api.ts)
- [x] Sanitize subtask titles/descriptions: length limits, no template injection (http-api.ts)
- [x] Sanitize git branch names: alphanumeric + hyphens/slashes only (worktree-manager.ts)
- [x] Add Zod schemas for all JSON parsed from Claude CLI (schemas.ts, claude-session.ts, cto.ts, reviewer.ts)
- [x] Add per-channel rate limiting on job creation (http-api.ts — 5 jobs/min/channel)

### Dynamic Resource Detection & Portability
- [x] Auto-detect CPU cores and total RAM at startup — derive MAX_CONCURRENT_WORKERS and MEMORY_CEILING from hardware
- [x] Default: 50% of CPU cores for workers, 50% of RAM as memory ceiling
- [x] Remove hardcoded resource defaults — everything derived from detected hardware unless overridden
- [ ] First-run experience: if no config exists, bot announces defaults in Discord
- [ ] `/config` command to adjust resource limits at runtime via Discord

### Code Quality & Duplication
- [x] Extract `runJob<T>` template method from duplicated runWorkerJob/runReviewJob (job-manager.ts)
- [x] Use Map<subtaskId, WorktreeInfo> instead of fragile index-based array in executeParallel
- [ ] Narrow Job interface: discriminated union (deferred — would touch too many files for marginal gain now)

### Test Coverage
- [x] `src/config/env.ts` — 9 tests
- [x] `src/workspace/control-plane.ts` — 20 tests
- [x] `src/adapter/resource-guard.ts` — 11 tests
- [x] `src/adapter/channel-mutex.ts` — 5 tests
- [x] `src/adapter/validation.ts` — 26 tests
- [x] `src/agents/schemas.ts` — 15 tests
- [x] `src/adapter/http-api.ts` — 11 tests (integration: auth, validation, health, resources)
- [ ] `src/adapter/job-manager.ts` — job lifecycle, abort handling, eviction
- [ ] `src/agents/claude-session.ts` — session persistence, JSON parsing

### Reliability & Resource Management
- [x] Job map hard cap (1000) — prevent unbounded growth with oldest-first eviction
- [x] Worktree cleanup retry with backoff (10s, 30s, 2min)
- [x] Wrap eviction timer callback in try-catch
- [x] Health check endpoint: GET /health (no auth, returns uptime + memory + workers)
- [x] Graceful shutdown: stop adapter → cancel jobs → stop API → clean worktrees → exit

### Production Readiness
- [ ] Structured JSON logging (replace console.log with structured logger)
- [ ] Discord rate limiting (message queue with backoff on 429s)
- [ ] Error recovery — auto-restart sessions on CLI failure

## Acceptance Criteria
- [x] All 3 HIGH security issues fixed with tests
- [x] System auto-detects hardware and configures resource limits
- [x] Test coverage on 7 critical modules (97 new tests)
- [x] No unbounded Map growth — hard caps enforced
- [x] Failed worktree cleanup retried with backoff
- [x] Graceful shutdown with ordered cleanup
- [x] Health check endpoint available
- [ ] Bot can be deployed on a different machine by setting only DISCORD_BOT_TOKEN
- [ ] First-run setup or `/config` for runtime adjustment

## Decisions Made This Phase
- 2026-03-19: Input validation is deterministic — ValidationError returns 400
- 2026-03-19: repoPath blocks system dirs (/etc, /proc, /var, /sys, /dev, /boot, /sbin)
- 2026-03-19: Dynamic resource defaults: 50% CPU cores for workers, 50% RAM ceiling
- 2026-03-19: Job map hard cap at 1000 with oldest-completed-first eviction
- 2026-03-19: Zod schemas replace all `as` casts for CLI JSON parsing (schemas.ts)
- 2026-03-19: Worktree cleanup retries 3 times with 10s/30s/2min backoff
- 2026-03-19: Rate limit: 5 job creations per channel per minute
- 2026-03-19: Narrow Job interface deferred — would touch all consumers for marginal gain at current scale
