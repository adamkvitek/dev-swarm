# Phase 05 — Hardening, Security, Tests & Portability
Status: ACTIVE

## Goal
Make the system safe, tested, portable, and robust — addressing all HIGH findings from the codebase analysis before scaling further.

## Tasks

### Security Fixes (HIGH priority — do first)
- [x] Validate `repoPath`: must be absolute, canonicalized, no traversal (http-api.ts)
- [x] Sanitize subtask titles/descriptions: length limits, no template injection (http-api.ts)
- [x] Sanitize git branch names: alphanumeric + hyphens/slashes only (worktree-manager.ts)
- [ ] Add Zod schemas for all JSON parsed from Claude CLI (claude-session.ts, cto.ts, worker.ts, reviewer.ts)
- [ ] Add per-channel rate limiting on job creation (job-manager.ts or http-api.ts)

### Dynamic Resource Detection & Portability
- [x] Auto-detect CPU cores and total RAM at startup — derive MAX_CONCURRENT_WORKERS and MEMORY_CEILING from hardware
- [x] Default: 50% of CPU cores for workers, 50% of RAM as memory ceiling
- [ ] First-run experience: if no config exists, bot announces defaults in Discord and tells user how to change them
- [ ] `/config` command (or similar) to adjust resource limits at runtime via Discord
- [ ] Codex reviewer respects same resource limits (not just workers)
- [x] Remove hardcoded resource defaults — everything derived from detected hardware unless overridden

### Code Quality & Duplication
- [x] Extract `runJob<T>` template method from duplicated runWorkerJob/runReviewJob (job-manager.ts)
- [ ] Narrow Job interface: discriminated union (WorkerJob | ReviewJob) instead of 7+ optional fields
- [ ] Use Map<subtaskId, WorktreeInfo> instead of fragile index-based array in executeParallel

### Test Coverage (target: all critical business logic)
- [x] `src/config/env.ts` — schema validation, defaults, ~ transform, coercion, error messages (9 tests)
- [x] `src/workspace/control-plane.ts` — path matching, self-repo detection, NEVER_MODIFY enforcement (20 tests)
- [x] `src/adapter/resource-guard.ts` — memory calculations, capacity checks, threshold enforcement (11 tests)
- [x] `src/adapter/channel-mutex.ts` — lock acquisition/release, per-channel serialization (5 tests)
- [x] `src/adapter/validation.ts` — repoPath, subtasks, techStack, branch-safe IDs (26 tests)
- [ ] `src/adapter/job-manager.ts` — job lifecycle, abort handling, eviction, callbacks, concurrency limits
- [ ] `src/agents/claude-session.ts` — session persistence, JSON parsing, error handling
- [ ] `src/adapter/http-api.ts` — auth, routing, input validation, error responses

### Reliability & Resource Management
- [x] Job map hard cap (1000) — prevent unbounded growth with oldest-first eviction
- [ ] Worktree cleanup retry with backoff on failure (not fire-and-forget)
- [x] Wrap eviction timer callback in try-catch
- [ ] Health check endpoint on HTTP API (GET /health)
- [ ] Graceful shutdown: drain message queue, await pending cleanup, save session IDs

### Production Readiness
- [ ] Structured JSON logging (replace console.log with structured logger)
- [ ] Per-channel session isolation (already exists, verify under load)
- [ ] Discord rate limiting (message queue with backoff on 429s)
- [ ] Error recovery — auto-restart sessions on CLI failure

## Acceptance Criteria
- [x] All 3 HIGH security issues fixed with tests proving the fix
- [x] System auto-detects hardware and configures resource limits accordingly
- [x] Test coverage on 5 critical modules (env, control-plane, resource-guard, channel-mutex, validation)
- [x] No unbounded Map growth — hard caps enforced
- [ ] Failed worktree cleanup retried, not silently lost
- [ ] Bot can be deployed on a different machine by setting only DISCORD_BOT_TOKEN
- [ ] `/config` (or equivalent) allows runtime resource adjustment

## Decisions Made This Phase
- 2026-03-19: Input validation is deterministic (not prompt-based) — ValidationError returns 400
- 2026-03-19: repoPath blocks system dirs (/etc, /proc, /var, /sys, /dev, /boot, /sbin)
- 2026-03-19: Dynamic resource defaults: 50% CPU cores for workers, 50% RAM ceiling
- 2026-03-19: Job map hard cap at 1000 with oldest-completed-first eviction

## Decisions To Make
- Structured logger choice: pino vs winston vs custom (pino recommended for perf)
- Session persistence format: JSON file vs SQLite
- Rate limiting strategy: token bucket vs sliding window
- Whether to add OS-level sandboxing (macOS seatbelt) for workers — research needed
