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

## 2026-03-18 — Cross-model review: Claude develops, Codex reviews

**Chosen:** Claude (Sonnet) for CTO + worker agents, OpenAI (o3) for reviewer agent
**Alternatives:** Claude reviews its own output, single-model pipeline
**Why:** Using a different model family for review avoids the "blind spot" problem where a model doesn't catch its own systematic errors. Cross-model review produces genuinely different feedback.
**Trade-offs:** Two API keys required, two billing accounts, potential inconsistency in code style preferences between models.
**Revisit if:** Anthropic releases a dedicated code review model, or if review quality doesn't measurably improve over single-model.

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

---

## 2026-03-18 — Layered self-modification guardrails for recursive safety

**Chosen:** Four-layer defense when agents target the bot's own codebase:
1. **Deterministic path validation** (`control-plane.ts`) — checks changed files against a protected path list before merge. Not prompt-based — prompts are suggestions, this is enforcement.
2. **Self-repo detection** (`isSelfRepo()`) — detects when the target repo is dev-swarm itself using distinctive file fingerprinting. Triggers restricted worker prompts and pre-merge validation.
3. **Prompt-level restrictions** (`SELF_REPO_WORKER_ADDENDUM`) — warns workers about control plane boundaries. Unreliable on its own (LLMs don't always follow instructions), but useful as a first signal that reduces violations.
4. **CODEOWNERS** — requires @maintainer review for all control plane paths. Git-level enforcement independent of the bot's own code.
**Alternatives:** Single-layer prompt-only restrictions (unreliable — LLMs follow instructions probabilistically). Blanket block on self-modification (too restrictive — legitimate use case to add features to the bot). Separate repo for the bot (cleanest but adds operational complexity).
**Why:** Self-modification is a recursive risk — if a worker breaks the bot, the system that manages agents is broken. The runaway agent incident (60GB memory, uncontrolled writes) demonstrated this isn't theoretical. Defense must be deterministic (not prompt-based), layered (no single point of failure), and allow the legitimate use case of proposing bot improvements for human review.
**Trade-offs:** Adds validation overhead on every merge when targeting self. The protected path list requires manual maintenance — new infrastructure paths must be added to CONTROL_PLANE_PATTERNS. Self-repo detection uses file fingerprinting (heuristic, not cryptographic).
**Revisit if:** The bot moves to a separate repo from target codebases (eliminates recursive risk), or if OS-level sandboxing (macOS seatbelt / Linux bubblewrap) is added for deeper isolation.

---

## 2026-03-19 — Pino for structured logging (over Winston)

**Chosen:** Pino as the structured JSON logger, replacing all 62 console.log/warn/error calls.
**Alternatives:** Winston (more configurable, multiple built-in transports), Bunyan (abandoned), custom wrapper around console
**Why:** Pino is 5-10x faster than Winston, outputs JSON by default (matches our needs), and follows Unix philosophy — it writes JSON to stdout, you pipe it wherever. We don't need Winston's built-in file rotation or HTTP transports; we're a CLI tool, not a web service. Pino has the highest npm downloads (~22M/week vs Winston's ~19M). Dev experience via `pino-pretty` pipe.
**Trade-offs:** Less built-in flexibility than Winston. Adding file rotation or remote transport requires s (pino-file, pino-socket). The Unix pipe approach is different from Winston's "configure transports in code" model.
**Revisit if:** We need complex transport routing (multiple destinations with different filters), or if deployment requires in-process log rotation.

---

## 2026-03-19 — Concrete coding standards over aspirational guidelines for AI agents

**Chosen:** Structured markdown files with quantified rules (functions under 30 lines, nesting under 3 levels) and bad/good code examples. Universal rules + 10 language-specific standards + 35-point review checklist. Auto-injected based on tech_stack detection.
**Alternatives:** Aspirational guidelines ("write clean code"), no standards (let agents freestyle), single monolithic document
**Why:** Research shows AI agents reliably follow concrete, quantified constraints but ignore vague aspirational statements. Per IEEE Spectrum (2026): LLMs increasingly generate code that "appears to work but silently fails" — removing safety checks, generating happy-path-only error handling, inventing dependencies. The standards target these documented anti-patterns specifically. Your friend's 3 principles (specs written down, narrow interfaces, tests for everything) form the universal foundation.
**Trade-offs:** More context injected into every worker prompt (higher token cost). Standards may conflict with existing project patterns — worker must be told to follow existing patterns first, standards second. Language detection is keyword-based (not file analysis).
**Revisit if:** Standards are too prescriptive for a specific project type, or if token costs become significant (consider summarizing standards for smaller tasks).
