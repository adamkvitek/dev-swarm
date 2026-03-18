# Phase 06 — Agent Code Style Guide + Quality Standards
Status: PENDING

## Goal
Establish code quality standards that all spawned agents follow, based on top industry practices. Agents produce code that meets the bar of top-tier engineering organizations.

## Tasks
- [ ] Research code style guides: Google, Microsoft, Airbnb, Uber, Stripe, Meta (what each does best)
- [ ] Create `prompts/code-standards.md` — injected into every worker agent's system prompt
- [ ] Covers: naming, error handling, testing expectations, documentation, architecture patterns
- [ ] Language-specific sections: TypeScript, Python, Go, Rust (based on project needs)
- [ ] Review checklist — injected into reviewer agent's system prompt
- [ ] Architecture decision template — agents log decisions to DECISIONS.md
- [ ] Security standards — OWASP top 10 awareness, input validation, secrets management
- [ ] Performance standards — async patterns, resource management, memory discipline
- [ ] Testing standards — coverage expectations, test naming, test structure
- [ ] Integrate with Phase 3 MCP tools — style guide automatically included in worker prompts

## Acceptance Criteria
- Every spawned worker agent receives the code standards as part of its context
- Reviewer agent evaluates against the style guide explicitly
- Style guide covers at least: naming, error handling, testing, security, architecture
- Standards are language-aware (different rules for TS vs Python vs Go)
- A new developer reading the style guide understands the quality bar
