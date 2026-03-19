# Phase 06 — Agent Code Style Guide + Quality Standards
Status: DONE

## Goal
Establish enforceable code quality standards that all spawned agents follow. Based on research from Google, Airbnb, Stripe, Uber, OWASP, and AI-specific anti-pattern studies.

## Key Insight
"Treat AI like a junior developer with perfect syntax and zero judgment." (Addy Osmani, 2026)
Quality comes from the gates, not from the generator. Rules must be concrete and quantified — vague aspirational statements are ignored by LLMs.

## Foundation (Adam's friend's 3 principles)
1. Specs must be written down (documents or comments, never implicit)
2. Narrow interfaces (minimize coupling)
3. Automated tests for everything

## Tasks

### Standards Documents
- [ ] `prompts/code-standards.md` — Universal rules injected into every worker prompt
- [ ] `prompts/standards/typescript.md` — TypeScript top 5 rules
- [ ] `prompts/standards/python.md` — Python top 5 rules
- [ ] `prompts/standards/go.md` — Go top 5 rules
- [ ] `prompts/standards/rust.md` — Rust top 5 rules
- [ ] `prompts/standards/java.md` — Java top 5 rules
- [ ] `prompts/standards/csharp.md` — C# top 5 rules
- [ ] `prompts/standards/swift.md` — Swift top 5 rules
- [ ] `prompts/standards/ruby.md` — Ruby top 5 rules
- [ ] `prompts/review-checklist.md` — Review checklist for reviewer agent

### Integration
- [ ] Worker agent: detect language from tech stack, inject universal + language-specific standards
- [ ] Reviewer agent: inject review checklist + security checklist into prompt
- [ ] Standards auto-loaded based on tech_stack parameter (not hardcoded)

### Verification
- [ ] Typecheck + tests pass
- [ ] Commit with proper messages

## Acceptance Criteria
- Every worker agent receives universal standards + language-specific rules
- Reviewer evaluates against the review checklist and security checklist
- Standards are concrete and quantified (not vague)
- Language detection from tech_stack is automatic
- A human reading the standards understands the quality bar
