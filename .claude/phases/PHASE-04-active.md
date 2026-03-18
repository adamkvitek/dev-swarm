# Phase 04 — Agentic Workers & Real Code Output
Status: ACTIVE

## Goal
Agents can read repos, write code to disk, run tests, and interact with git — delivering real working code through the Discord pipeline.

## Tasks
- [x] Create WorktreeManager — git worktree lifecycle with serialized creation queue
- [x] Resolve ~ in WORKSPACE_DIR (env.ts transform)
- [x] Switch worker agents to full agentic mode (Read/Write/Edit/Bash/Glob/Grep tools)
- [x] Workers operate in isolated git worktrees with real filesystem access
- [x] Workers commit changes, capture diffs and file lists
- [x] WorkerResult interface: code string → workDir + diff + summary
- [x] Reviewer runs in worktree with full filesystem access (codex exec --full-auto -C dir)
- [x] JobManager injects WorktreeManager, threads repoPath through pipeline
- [x] Worktree cleanup on cancel, eviction, and shutdown
- [x] MCP tools: add repo_path parameter to spawn_workers
- [x] HTTP API: require repoPath field on POST /jobs/workers
- [x] System prompt updated: repo_path requirement, feature branch workflow
- [x] Discord adapter: include files changed + feature branch in notifications
- [x] index.ts: wire WorktreeManager lifecycle
- [x] Typecheck: `npx tsc --noEmit` — clean
- [x] Tests: `npx vitest run` — 58/58 pass

### Verification Infrastructure (completed in prior session)
- [x] Fix OpenClaw guard — host-only blocking with OPENCLAW_VM_CONFIRMED opt-in
- [x] Fix CLI runner stdin hanging — always close stdin
- [x] Add runtime detection to verify-all.mjs (graceful skip for missing runtimes)
- [x] Simplify C# execution to dotnet run (bare file, .NET 10+)
- [x] Create cross-language samples: hello-world, fizzbuzz (Python, Java, C#)
- [x] Write vitest tests for assertions + CLI runner (58 tests, all passing)
- [x] Run full verification: 16/16 pass, 0 cross-language inconsistencies

## Acceptance Criteria
- [x] Workers run in isolated git worktrees (parallel workers can't conflict)
- [x] Workers read real code, write real files, run tests
- [x] Workers commit changes and return diffs
- [x] Reviewer runs with full filesystem access in the worktree
- [x] On APPROVE: changes merge to feature/{task} branch
- [x] Worktrees cleaned up on cancel, eviction, shutdown
- [x] No runaway agents — all processes respect timeouts
- [ ] Manual end-to-end test on a real repo (requires running bot)

## Decisions Made This Phase
- 2026-03-18: Simplified C# execution from scaffolded .csproj to bare `dotnet run file.cs` (.NET 10+ required)
- 2026-03-18: OpenClaw guard uses OPENCLAW_VM_CONFIRMED=1 env var for VM opt-in
- 2026-03-18: Workers use self-managed git worktrees (not Claude CLI --worktree) for control over paths, branch names, cleanup
- 2026-03-18: Worktree creation serialized via async queue to prevent git lock file conflicts
- 2026-03-18: Reviewer uses Codex in full agentic mode with `-C <worktreeDir>` for filesystem access
- 2026-03-18: On APPROVE, worker branches merged into `feature/{task-summary}` branch
- 2026-03-18: Explicit `repo_path` required — Claude extracts it from user's Discord message
