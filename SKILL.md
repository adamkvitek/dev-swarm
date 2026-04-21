# Dev Swarm — Skill Manifest

## What This Is

An AI development team orchestrator. You give it a task and a repo — it coordinates multiple AI models to implement, review, and deliver working code.

## Capabilities

| Capability | How | Models |
|-----------|-----|--------|
| **Code implementation** | Workers read existing code, write files, run tests in isolated git worktrees | Claude (primary) |
| **Code review** | LLM Council: 3 models review anonymously, cross-rank, synthesize verdict | Claude + Codex + Gemini |
| **Council implementation** | Multiple models implement the same task, best is selected | Claude + Codex + Gemini |
| **Image analysis** | Screenshots, UI mockups, architecture diagrams, error screenshots | Gemini (native read_file) |
| **Audio analysis** | Voice recordings, audio specs | Gemini (native read_file) |
| **PDF analysis** | Spec documents, design docs, API references | Gemini (native read_file) |
| **Self-modification** | Can modify its own codebase with 4-layer safety guardrails | All (restricted) |

## Available Models

| Model | CLI | Strengths | Used For |
|-------|-----|-----------|----------|
| **Claude** | `claude` | Architecture, refactoring, TypeScript/Python/Go, reasoning | Workers, CTO, review council, synthesis |
| **Codex** | `codex` | Bug detection, logical errors, code analysis | Review council, council workers |
| **Gemini** | `gemini` | Multimodal (images, audio, PDFs), broad language support | Review council, council workers, media analysis |

## Modes

### Normal Mode (default)

```
User → CTO (Claude) → Workers (Claude) → Council Review → APPROVE/REVISE
```
- One model implements each subtask
- Three models review (anonymized council)
- Good for standard development tasks

### Council Mode (opt-in, for critical tasks)

```
User → CTO → Council Workers (Claude + Codex + Gemini) → Best picked → Council Review → APPROVE/REVISE
```
- Three models implement each subtask independently
- Judge compares implementations, picks the best
- Three models review the winning implementation
- Use when: security-critical code, core architecture, public APIs
- Cost: ~3x normal mode

### How to invoke

**Terminal:**
```
npm run dev-swarm

You: Add auth to /path/repo. Use council mode.
You: Review /path/repo for security issues.
You: Analyze the screenshot at /path/screenshot.png and fix the UI bug in /path/repo.
```

**Discord:**
```
@bot Add auth to /path/repo
@bot Add auth to /path/repo. Use council mode — this is critical.
@bot Review the screenshot at /path/mockup.png and implement the design in /path/repo.
```

The CTO detects keywords like "council mode", "critical", "important", "security-sensitive" and escalates to council automatically.

## Coding Standards

Workers receive language-specific coding standards automatically:

| Language | File | Key Rules |
|----------|------|-----------|
| TypeScript | [typescript.md](prompts/standards/typescript.md) | strict:true, ban any, discriminated unions, no floating promises |
| Python | [python.md](prompts/standards/python.md) | mypy --strict, explicit None, Pydantic at boundaries |
| Go | [go.md](prompts/standards/go.md) | Check every error, accept interfaces/return structs, context propagation |
| Rust | [rust.md](prompts/standards/rust.md) | No unwrap(), minimize clone(), SAFETY comments on unsafe |
| Java | [java.md](prompts/standards/java.md) | Never swallow exceptions, Optional for null, immutable by default |
| C# | [csharp.md](prompts/standards/csharp.md) | Nullable reference types, async all the way, sealed by default |
| C | [c.md](prompts/standards/c.md) | Bounds checking, malloc/free pairing, no use-after-free |
| C++ | [cpp.md](prompts/standards/cpp.md) | Smart pointers, RAII, no UB, std containers |
| Swift | [swift.md](prompts/standards/swift.md) | Trust concurrency checker, actors over locks, no force unwrapping |
| Ruby | [ruby.md](prompts/standards/ruby.md) | Sorbet/RBS types, service objects over callbacks |

**Project conventions always override.** If the target repo has CONTRIBUTING.md, .eslintrc, pyproject.toml, etc., those take priority.

Universal rules: [code-standards.md](prompts/code-standards.md)
Review checklist: [review-checklist.md](prompts/review-checklist.md) (35 items: OWASP, memory safety, AI anti-patterns)

## Safety Guardrails

When agents target this repository itself:
1. **Deterministic path validation** — blocks auto-merge of control plane files
2. **Self-repo detection** — fingerprints the target repo
3. **Prompt restrictions** — workers warned about protected paths
4. **CODEOWNERS** — requires human review for infrastructure changes

## Configuration

All settings auto-detect from hardware. Override in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT_WORKERS` | 75% of CPU cores (min 2) | Max parallel workers |
| `MEMORY_CEILING_PCT` | 90% | Memory limit |
| `REVIEW_QUALITY_THRESHOLD` | 8 | Score needed to APPROVE (1-10) |
| `WORKSPACE_DIR` | ~/dev/swarm-workspace | Worktree directory |
| `LOG_LEVEL` | info | Pino log level |
| `CLAUDE_CLI` | claude | Claude CLI path |
| `CODEX_CLI` | codex | Codex CLI path |
| `GEMINI_CLI` | gemini | Gemini CLI path |
