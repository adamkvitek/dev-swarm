# Decisions

## 2026-03-21 — Resource ceilings: 90% warning, 75% recovery

**Chosen:** Uniform 90% ceiling for both memory and CPU. Recovery at 75% (15% hysteresis). Polling every 30 seconds.
**Alternatives:**
- Keep split ceilings (inconsistent, confusing)
- 95% ceiling (too aggressive, leaves no headroom for OS)
- 85% ceiling (too conservative for I/O-bound LLM workers)
**Why:** Multi-model audit (Claude + Codex + Gemini) found ceiling values were inconsistent across config, code, tests, and docs. Unified to 90% everywhere. 15% hysteresis (recovery at 75%) prevents oscillation when usage hovers near the threshold.
**Trade-offs:** Tests require the host machine to be below 90% memory to pass "healthy" assertions.
**Revisit if:** Workers become more CPU/memory intensive, or if users on low-RAM machines (8GB) hit the ceiling during normal IDE usage.

---

## 2026-03-18 — Replace custom state machine with Claude CLI + MCP

**Chosen:** Use Claude CLI with `--resume` and MCP servers as the Discord bot brain. Thin adapter bridges Discord <> Claude CLI.
**Alternatives:**
- Claude API with tool_use (requires API key management, rebuilds conversation handling)
- Keep custom state machine and add rate limiting (band-aid, doesn't fix root cause)
- Claude Agent SDK (overkill for CLI-first architecture)
**Why:** A custom intent classifier and state machine is a poor approximation of what Claude does natively. Claude CLI with `--resume` handles persistent sessions, context, and natural conversation. MCP servers give Claude tools to act (Discord, workers, resources) without hardcoding decision logic.
**Trade-offs:** Dependent on Claude CLI behavior and MCP protocol stability. Each message is a separate CLI invocation (stateless between calls, but session context persists via --resume). Async worker notifications require adapter-level plumbing.
**Revisit if:** Claude CLI adds a daemon/server mode, or Anthropic releases a first-party Discord integration.

---

## 2026-03-18 — Resource limits: hardware-aware defaults

**Chosen:** Max concurrent workers = 75% of CPU cores. Refuse new work when memory or CPU > 90%.
**Alternatives:**
- No limits (dangerous on shared machines)
- Dynamic scaling based on load (complex, premature)
- Fixed limit of 2 (too conservative)
**Why:** Each CLI process uses ~1-2GB RSS. Workers are mostly I/O-bound (waiting on LLM responses), so 75% of cores is safe. 90% ceiling as hard stop leaves headroom for OS + bot + reviewer.
**Trade-offs:** May underutilize hardware during light workloads. Excess tasks queue rather than execute immediately.
**Revisit if:** Moving to a more powerful machine, or adding remote worker execution.

---

## 2026-03-18 — CLI over API for all agent communication

**Chosen:** Use `claude`, `codex`, `gemini` CLIs via subprocess spawning. No direct API calls.
**Alternatives:** Anthropic SDK for direct API access
**Why:** CLI handles auth, model selection, and session management. `--resume` gives conversation persistence. `--mcp-config` gives tool integration. Uses existing subscriptions — no API keys needed.
**Trade-offs:** Less control over model parameters, token limits, streaming. CLI process overhead (~100ms startup per call). Can't use advanced API features (prompt caching, batch API).
**Revisit if:** Need streaming responses in Discord, or CLI costs become prohibitive vs. API.

---

## 2026-03-18 — Cross-model review: multiple models review each other

**Chosen:** Claude for CTO + worker agents, Codex and Gemini for review council
**Alternatives:** Claude reviews its own output, single-model pipeline
**Why:** Using different model families for review avoids the "blind spot" problem where a model doesn't catch its own systematic errors. Cross-model review produces genuinely different feedback.
**Trade-offs:** Multiple CLI subscriptions needed for full council mode. Potential inconsistency in code style preferences between models.
**Revisit if:** A single model demonstrably catches its own errors as well as cross-model review does.

---

## 2026-03-18 — MCP server as thin HTTP client, adapter holds all state

**Chosen:** MCP server is stateless — each tool call is an HTTP request to the adapter's internal API. The adapter's JobManager owns all job state and worker lifecycle.
**Alternatives:** MCP server manages its own state. Shared SQLite/file for inter-process state.
**Why:** Claude CLI (and its MCP server) are ephemeral — they exit after each message. Workers run for 30 minutes. Putting state in the always-running adapter process is the only reliable option. HTTP is simple, debuggable, and testable.
**Trade-offs:** Extra HTTP hop for every tool call (negligible on localhost). Adapter becomes a single point of failure.
**Revisit if:** Claude CLI adds a persistent daemon mode where MCP servers can hold state across invocations.

---

## 2026-03-18 — Raw http.createServer for internal API (no Express)

**Chosen:** Node built-in `http.createServer` for the internal API.
**Alternatives:** Express, Fastify, Hono
**Why:** Localhost-only, ~7 endpoints, zero external consumers. The API is an internal bridge, not a public service. A framework adds dependency weight with no benefit here.
**Trade-offs:** Manual routing and body parsing. Acceptable for this scale.
**Revisit if:** Endpoint count grows past ~15 or we need middleware (auth, rate limiting, validation).

---

## 2026-03-18 — Self-managed git worktrees for worker isolation

**Chosen:** Each worker runs in its own git worktree, managed by `WorktreeManager`. Worktree creation is serialized via an async queue to prevent git lock file conflicts.
**Alternatives:** Claude CLI's `--worktree` flag (less control), Docker containers per worker (overkill, adds 5s startup), branch-per-worker without worktrees (parallel workers would conflict)
**Why:** Worktrees give each worker a fully isolated filesystem view of the repo. Self-managing gives control over worktree paths, branch naming, and cleanup timing. Serialized creation avoids git's `.git/index.lock` conflicts.
**Trade-offs:** More code to maintain. Worktrees share the same .git directory, so very large repos may see I/O contention.
**Revisit if:** Worker count exceeds 10 concurrent (may need containerized isolation), or Claude CLI's worktree support matures enough to replace custom management.

---

## 2026-03-18 — Explicit repo_path from user, not auto-detected

**Chosen:** `spawn_workers` requires an explicit `repo_path` parameter. Claude extracts the path from the user's message.
**Alternatives:** Auto-detect repo from workspace conventions, use a config file per channel
**Why:** Users may have multiple repos and reference different ones in different requests. Auto-detection would be fragile and could write to the wrong repo. Explicit path is unambiguous.
**Trade-offs:** Users must include the repo path in their message.
**Revisit if:** The bot is scoped to a single repo per server/channel, making the path redundant.

---

## 2026-03-18 — Layered self-modification guardrails

**Chosen:** Four-layer defense when agents target the bot's own codebase:
1. **Deterministic path validation** — checks changed files against a protected path list before merge. Not prompt-based — this is enforcement.
2. **Self-repo detection** — detects when the target repo is dev-swarm itself using file fingerprinting. Triggers restricted worker prompts and pre-merge validation.
3. **Prompt-level restrictions** — warns workers about control plane boundaries. Unreliable on its own, but useful as a first signal.
4. **CODEOWNERS** — requires maintainer review for all control plane paths. Git-level enforcement.
**Alternatives:** Prompt-only restrictions (unreliable). Blanket block on self-modification (too restrictive). Separate repo for the bot (adds operational complexity).
**Why:** Self-modification is a recursive risk — if a worker breaks the bot, the system that manages agents is broken. Defense must be deterministic (not prompt-based), layered (no single point of failure), and allow the legitimate use case of proposing bot improvements for human review.
**Trade-offs:** Adds validation overhead on every merge when targeting self. The protected path list requires manual maintenance. Self-repo detection uses file fingerprinting (heuristic, not cryptographic).
**Revisit if:** The bot moves to a separate repo, or if OS-level sandboxing is added for deeper isolation.

---

## 2026-03-19 — Pino for structured logging (over Winston)

**Chosen:** Pino as the structured JSON logger.
**Alternatives:** Winston (more configurable), Bunyan (abandoned), custom wrapper
**Why:** Pino is 5-10x faster than Winston, outputs JSON by default, and follows Unix philosophy — write JSON to stdout, pipe it wherever. Dev experience via `pino-pretty` pipe.
**Trade-offs:** Less built-in flexibility than Winston. Adding file rotation or remote transport requires plugins.
**Revisit if:** We need complex transport routing or in-process log rotation.

---

## 2026-03-19 — Concrete coding standards over aspirational guidelines for AI agents

**Chosen:** Structured markdown files with quantified rules (functions under 30 lines, nesting under 3 levels) and bad/good code examples. Universal rules + 10 language-specific standards + 35-point review checklist. Auto-injected based on tech_stack detection.
**Alternatives:** Aspirational guidelines ("write clean code"), no standards, single monolithic document
**Why:** AI agents reliably follow concrete, quantified constraints but ignore vague aspirational statements. The standards target documented AI anti-patterns: removing safety checks, generating happy-path-only error handling, inventing dependencies. Three universal coding principles (specs written down, narrow interfaces, tests for everything) form the foundation.
**Trade-offs:** More context injected into every worker prompt (higher token cost). Standards may conflict with existing project patterns — worker must follow existing patterns first, standards second. Language detection is keyword-based.
**Revisit if:** Standards are too prescriptive, or if token costs become significant.
