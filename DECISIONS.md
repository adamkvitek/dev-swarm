# Decisions

## 2026-03-18 — Replace custom state machine with Claude CLI + MCP
**Chosen:** Use Claude CLI with `--resume` and MCP servers as the Discord bot brain. Thin adapter bridges Discord ↔ Claude CLI.
**Alternatives:**
- Claude API with tool_use (requires API key management, rebuilds conversation handling)
- Keep custom state machine and add rate limiting (band-aid, doesn't fix root cause)
- Claude Agent SDK (overkill for CLI-first architecture)
**Why:** The current custom-coded intent classifier, state machine, and session manager is a poor approximation of what Claude does natively. It caused a runaway agent incident (60GB memory, all channel messages processed on startup). Claude CLI with `--resume` already handles persistent sessions, context, and natural conversation. MCP servers give Claude tools to act (Discord, workers, resources) without hardcoding decision logic.
**Trade-offs:** Dependent on Claude CLI behavior and MCP protocol stability. Each message is a separate CLI invocation (stateless between calls, but session context persists via --resume). Async worker notifications require adapter-level plumbing.
**Revisit if:** Claude CLI adds a daemon/server mode, or Anthropic releases a first-party Discord integration.

---

## 2026-03-18 — Resource limits: 50% CPU cores, 80% memory ceiling
**Chosen:** Max concurrent workers = 4 (50% of 8 cores). Refuse new work when RSS > 80% of 16GB.
**Alternatives:**
- No limits (caused the 60GB incident)
- Dynamic scaling based on load (complex, premature)
- Fixed limit of 2 (too conservative for 8-core machine)
**Why:** 8 cores, 16GB RAM. Each Claude CLI process uses ~1-2GB RSS. 4 concurrent workers = ~8GB worst case, leaving headroom for OS + bot + reviewer. 80% memory ceiling (12.8GB) as hard stop.
**Trade-offs:** May underutilize hardware during light workloads. Excess tasks queue rather than execute immediately.
**Revisit if:** Moving to a more powerful machine, or adding remote worker execution.

---

## 2026-03-18 — CLI over API for all agent communication
**Chosen:** Use `claude` CLI (and `codex` CLI) via subprocess spawning. No direct Anthropic API calls.
**Alternatives:** Anthropic SDK (`@anthropic-ai/sdk`) for direct API access
**Why:** User already has CLI subscriptions. CLI handles auth, model selection, and session management. `--resume` gives free conversation persistence. `--mcp-config` gives free tool integration. No API key needed.
**Trade-offs:** Less control over model parameters, token limits, streaming. CLI process overhead (~100ms startup per call). Can't use advanced API features (prompt caching, batch API).
**Revisit if:** Need streaming responses in Discord, or CLI costs become prohibitive vs. API.

---

## 2026-03-18 — Save runaway agent work to branch, clean restart
**Chosen:** Committed 15,972 lines of unstaged changes to `wip/agent-chaos-2026-03-18`, reset main to clean state.
**Alternatives:** Try to fix the compilation errors and merge incrementally
**Why:** 13 type errors, agents worked on conflicting changes, no coherent architecture. Easier to start clean and cherry-pick useful infrastructure (circuit breakers, retry, logging) when needed.
**Trade-offs:** Some duplicate work if we need the same infrastructure later.
**Revisit if:** Never — the branch exists for reference.

---

## 2026-03-18 — Use OpenClaw as platform, not fork
**Chosen:** Install OpenClaw normally; build custom skill/extension for swarm orchestration in a private repo
**Alternatives:** Fork OpenClaw (too large/fast-moving, 308MB, multiple commits/hour), fork OpenSwarm (solo dev, 5 weeks old, no LICENSE file, known tech debt), build from scratch
**Why:** OpenClaw provides Discord integration, Perplexity support, coding-agent skills, and multi-platform messaging out of the box. Forking it would immediately diverge from a fast-moving upstream. A custom skill keeps our code small and focused while leveraging the full platform.
**Trade-offs:** Dependency on OpenClaw's stability and API surface. If OpenClaw makes breaking changes to the skill/plugin system, we need to adapt.
**Revisit if:** OpenClaw's skill API changes significantly, or if we need deeper control over the Discord layer than the skill system allows.

---

## 2026-03-18 — Cross-model review: Claude develops, Codex reviews
**Chosen:** Claude (Sonnet) for CTO + worker agents, OpenAI (o3) for reviewer agent
**Alternatives:** Claude reviews its own output, single-model pipeline
**Why:** Using a different model family for review avoids the "blind spot" problem where a model doesn't catch its own systematic errors. Cross-model review produces genuinely different feedback.
**Trade-offs:** Two API keys required, two billing accounts, potential inconsistency in code style preferences between models.
**Revisit if:** Anthropic releases a dedicated code review model, or if review quality doesn't measurably improve over single-model.

---

## 2026-03-18 — Discord.js directly for bot (not OpenClaw's Discord channel)
**Chosen:** Implement Discord bot with discord.js in our private repo
**Alternatives:** Use OpenClaw's built-in Discord channel integration and write the orchestration as a pure skill
**Why:** Starting with direct discord.js gives us full control over the interaction flow (session management, embeds, approval gates). We can migrate to OpenClaw's Discord channel later once the orchestration logic is proven.
**Trade-offs:** Duplicates some of OpenClaw's Discord functionality. Two Discord integrations running if OpenClaw is also connected to the same server.
**Revisit if:** The bot interaction patterns stabilize and OpenClaw's Discord channel can handle the full workflow.

---

## 2026-03-18 — Perplexity sonar-pro for research agent
**Chosen:** Perplexity API (sonar-pro model) as the research agent
**Alternatives:** Claude web search tool, OpenAI web browsing, manual research
**Why:** User has a Perplexity account. Dedicated search API is more cost-effective than burning Claude/OpenAI tokens on search tasks. Sonar-pro provides cited sources.
**Trade-offs:** Additional API dependency. Perplexity API availability/rate limits.
**Revisit if:** Claude or OpenAI add cost-effective built-in search that matches Perplexity quality.

---

## 2026-03-18 — MCP server as thin HTTP client, adapter holds all state
**Chosen:** MCP server is stateless — each tool call is an HTTP request to the adapter's internal API. The adapter's JobManager owns all job state and worker lifecycle.
**Alternatives:** MCP server manages its own state and communicates results back to adapter via callbacks. Shared SQLite/file for inter-process state.
**Why:** Claude CLI (and its MCP server) are ephemeral — they exit after each message. Workers run for 30 minutes. Putting state in the always-running adapter process is the only reliable option. HTTP is simple, debuggable, and testable.
**Trade-offs:** Extra HTTP hop for every tool call (negligible on localhost). Adapter becomes a single point of failure.
**Revisit if:** Claude CLI adds a persistent daemon mode where MCP servers can hold state across invocations.

---

## 2026-03-18 — Raw http.createServer for internal API (no Express)
**Chosen:** Node built-in `http.createServer` for the 7-endpoint internal API.
**Alternatives:** Express, Fastify, Hono
**Why:** Localhost-only, ~7 endpoints, zero external consumers. The API is an internal bridge, not a public service. A framework adds dependency weight with no benefit here.
**Trade-offs:** Manual routing and body parsing. Acceptable for this scale.
**Revisit if:** Endpoint count grows past ~15 or we need middleware (auth, rate limiting, validation).

---

## 2026-03-18 — OpenClaw must NEVER run on host OS, VM only
**Chosen:** Enforce that OpenClaw may only be executed inside a virtual machine. The runtime guard (`assertNotHostOpenClaw` in `cli-runner.ts`) blocks openclaw invocations unless the environment variable `OPENCLAW_VM_CONFIRMED=1` is set. This variable should only be configured inside a dedicated VM — never on the host.
**Alternatives:** Run OpenClaw directly on host (rejected — dangerous), containerize with Docker (insufficient isolation for this threat model), blanket-block all openclaw commands regardless of environment (rejected — prevents legitimate VM-side usage)
**Why:** Baptiste explicitly warned that running OpenClaw on the host is dangerous. OpenClaw's daemon (`openclaw onboard --install-daemon`) installs persistent background processes and has broad filesystem/network access. Running it on a developer's primary machine risks unintended side effects, data exfiltration, or system-level changes that are difficult to reverse.
**Trade-offs:** Requires VM setup for anyone who wants OpenClaw integration, which adds friction. Docker was considered but a full VM provides stronger isolation boundaries (separate kernel, network stack, filesystem). The env-var approach relies on operators not setting `OPENCLAW_VM_CONFIRMED=1` on the host — this is a trust boundary, not a cryptographic one.
**Revisit if:** OpenClaw adds a sandboxed execution mode with verifiable isolation guarantees, or if the project permanently drops OpenClaw integration.

---

## 2026-03-18 — Self-managed git worktrees for worker isolation
**Chosen:** Each worker runs in its own git worktree, managed by `WorktreeManager`. Worktree creation is serialized via an async queue to prevent git lock file conflicts.
**Alternatives:** Claude CLI's `--worktree` flag (less control over paths/branches/cleanup), Docker containers per worker (overkill, adds 5s startup per worker), branch-per-worker without worktrees (parallel workers would conflict on the same working directory)
**Why:** Worktrees give each worker a fully isolated filesystem view of the repo. Self-managing (vs Claude CLI's --worktree) gives control over worktree paths (`{WORKSPACE_DIR}/worker-{shortJobId}-{subtaskId}`), branch naming (`worker/{shortJobId}/{subtaskId}`), and cleanup timing (on cancel, eviction, shutdown). Serialized creation avoids git's `.git/index.lock` conflicts.
**Trade-offs:** More code to maintain. Worktrees share the same .git directory, so very large repos may see I/O contention. Branch proliferation if cleanup fails.
**Revisit if:** Worker count exceeds 10 concurrent (may need containerized isolation), or Claude CLI's worktree support matures enough to replace custom management.

---

## 2026-03-18 — Explicit repo_path from user, not auto-detected
**Chosen:** `spawn_workers` requires an explicit `repo_path` parameter. Claude extracts the path from the user's Discord message.
**Alternatives:** Auto-detect repo from workspace conventions, use a config file per channel, default to a single configured repo
**Why:** Users may have multiple repos and reference different ones in different requests. Auto-detection would be fragile and could write to the wrong repo. Explicit path is unambiguous.
**Trade-offs:** Users must include the repo path in their message. Claude needs to extract it correctly.
**Revisit if:** The bot is scoped to a single repo per server/channel, making the path redundant.
