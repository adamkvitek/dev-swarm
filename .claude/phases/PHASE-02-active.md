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
  - [ ] Process timeout enforcement (kill runaway agents)
  - [ ] Max concurrent agent limit
  - [ ] Working directory restrictions (agents can't escape the workspace)
  - [ ] `!cancel` kills all running agent processes
- [ ] Output delivery — send code diffs/summaries back to Discord (not full file contents)
- [ ] Handle Discord message length limits (2000 chars) — use embeds or file attachments for long output
- [ ] Test end-to-end with a real task on a real repo

## Acceptance Criteria
- User sends a task in Discord referencing a local repo
- CTO agent reads the repo and decomposes the task
- Worker agents write real code to files
- Reviewer agent reviews actual files and provides feedback
- Review loop iterates and improves code
- Final output is committed to a branch
- No runaway agents — all processes respect timeouts

## Decisions To Make
- Should workers run in isolated git worktrees or directly on the branch?
- Should the bot auto-commit after each iteration or only on final approval?
- How to handle multi-file changes in Discord messages (file attachments vs gist links)?
