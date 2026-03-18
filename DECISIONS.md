# Decisions

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

## 2026-03-18 — OpenClaw must NEVER run on host OS, VM only
**Chosen:** Enforce that OpenClaw may only be executed inside a virtual machine. The runtime guard (`assertNotHostOpenClaw` in `cli-runner.ts`) blocks openclaw invocations unless the environment variable `OPENCLAW_VM_CONFIRMED=1` is set. This variable should only be configured inside a dedicated VM — never on the host.
**Alternatives:** Run OpenClaw directly on host (rejected — dangerous), containerize with Docker (insufficient isolation for this threat model), blanket-block all openclaw commands regardless of environment (rejected — prevents legitimate VM-side usage)
**Why:** Baptiste explicitly warned that running OpenClaw on the host is dangerous. OpenClaw's daemon (`openclaw onboard --install-daemon`) installs persistent background processes and has broad filesystem/network access. Running it on a developer's primary machine risks unintended side effects, data exfiltration, or system-level changes that are difficult to reverse.
**Trade-offs:** Requires VM setup for anyone who wants OpenClaw integration, which adds friction. Docker was considered but a full VM provides stronger isolation boundaries (separate kernel, network stack, filesystem). The env-var approach relies on operators not setting `OPENCLAW_VM_CONFIRMED=1` on the host — this is a trust boundary, not a cryptographic one.
**Revisit if:** OpenClaw adds a sandboxed execution mode with verifiable isolation guarantees, or if the project permanently drops OpenClaw integration.
