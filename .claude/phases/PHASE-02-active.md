# Phase 02 — Agentic Workers & Real Code Output
Status: ACTIVE

## Goal
Agents can read repos, write code to disk, run tests, and interact with git — delivering real working code through the Discord pipeline.

## Tasks
- [ ] Switch worker agents from text-only to full agentic mode (read/write files, run commands)
- [ ] Add working directory support — agents work in the user's specified repo/branch
- [ ] CTO agent reads the actual codebase before decomposing tasks
- [ ] Workers write code to actual files (not JSON responses)
- [ ] Reviewer agent reads actual files and runs linting/tests
- [ ] Add git integration — agents create branches, commit changes
- [ ] Add safety guardrails:
  - [x] Process timeout enforcement (kill runaway agents)
  - [ ] Max concurrent agent limit
  - [ ] Working directory restrictions (agents can't escape the workspace)
  - [ ] `!cancel` kills all running agent processes
- [ ] Output delivery — send code diffs/summaries back to Discord (not full file contents)
- [ ] Handle Discord message length limits (2000 chars) — use embeds or file attachments for long output
- [ ] Test end-to-end with a real task on a real repo

### Verification Infrastructure (completed)
- [x] Fix OpenClaw guard — host-only blocking with OPENCLAW_VM_CONFIRMED opt-in
- [x] Fix CLI runner stdin hanging — always close stdin
- [x] Add runtime detection to verify-all.mjs (graceful skip for missing runtimes)
- [x] Simplify C# execution to dotnet run (bare file, .NET 10+)
- [x] Create cross-language samples: hello-world, fizzbuzz (Python, Java, C#)
- [x] Write vitest tests for assertions + CLI runner (58 tests, all passing)
- [x] Run full verification: 16/16 pass, 0 cross-language inconsistencies

## Acceptance Criteria
- User sends a task in Discord referencing a local repo
- CTO agent reads the repo and decomposes the task
- Worker agents write real code to files
- Reviewer agent reviews actual files and provides feedback
- Review loop iterates and improves code
- Final output is committed to a branch
- No runaway agents — all processes respect timeouts

## Decisions Made This Phase
- 2026-03-18: Simplified C# execution from scaffolded .csproj to bare `dotnet run file.cs` (.NET 10+ required)
- 2026-03-18: OpenClaw guard uses OPENCLAW_VM_CONFIRMED=1 env var for VM opt-in

## Decisions To Make
- Should workers run in isolated git worktrees or directly on the branch?
- Should the bot auto-commit after each iteration or only on final approval?
- How to handle multi-file changes in Discord messages (file attachments vs gist links)?
