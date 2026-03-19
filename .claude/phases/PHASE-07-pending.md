# Phase 07 — Worker Council, Multimodal, and SKILL.md
Status: PENDING

## Goal
Enable multi-model worker implementations for critical tasks, leverage Gemini's multimodal strengths for visual/audio content, and document the swarm's capabilities in a proper SKILL.md manifest.

## Tasks

### Worker Council (opt-in mode for critical tasks)
- [ ] New MCP tool: `spawn_council` — like spawn_workers but fans out each subtask to Claude AND Gemini workers in parallel (2 implementations per subtask)
- [ ] Synthesis agent: compares implementations, cherry-picks best parts (error handling from one, architecture from another, tests from a third)
- [ ] Re-review: synthesized code goes through the review council again
- [ ] Invocation modes:
  - Discord: "use council mode" or "this is critical" in the message → CTO triggers council
  - Terminal: `council: true` flag or "use council mode" in prompt
  - MCP tool: `spawn_council` alongside existing `spawn_workers`
- [ ] Cost/time estimation: tell user upfront "council mode uses 3x resources"
- [ ] Graceful degradation: if one model fails, continue with remaining

### Gemini Multimodal Integration
- [ ] System prompt tells CTO to favor Gemini for image/audio/PDF analysis
- [ ] When task mentions screenshots, UI, mockups, diagrams, audio → CTO routes to Gemini
- [ ] Gemini worker can read images (PNG, JPG, GIF, WEBP, SVG, BMP), audio (MP3, WAV, etc.), and PDFs natively via `read_file`
- [ ] For video: Gemini extracts frames via ffmpeg shell commands, then analyzes frames
- [ ] Council mode for multimodal: show what Claude sees (text description) vs what Gemini sees (actual image analysis)

### SKILL.md — Project Manifest
- [ ] Create `SKILL.md` documenting:
  - What the swarm can do (capabilities matrix)
  - Available agent backends (Claude, Codex, Gemini) with strengths
  - Coding standards (link to prompts/standards/)
  - Review process (council, anonymization, ranking)
  - How to invoke different modes (normal, council, multimodal)
  - Safety guardrails and limitations
  - Configuration reference

### Integration & Wiring
- [ ] Add `spawn_council` to MCP tools (tools.ts, server.ts, http-api.ts)
- [ ] JobManager: new `createCouncilJob()` method
- [ ] Worker agent: support Gemini CLI as alternative worker backend
- [ ] Update README with council mode and multimodal docs
- [ ] Update system prompt with council invocation guidance

### README.md Update
- [ ] Rewrite README with full architecture diagrams (council flow, multimodal routing)
- [ ] Document terminal mode prominently (no Discord, private data)
- [ ] Document council mode invocation (Discord + terminal examples)
- [ ] Document multimodal capabilities (which file types, how to trigger)
- [ ] Add model strengths comparison table
- [ ] Add example sessions (terminal transcript showing council in action)

### Verification
- [ ] Typecheck clean
- [ ] Existing 155 tests pass
- [ ] Manual test: spawn_council produces multiple implementations
- [ ] Manual test: Gemini analyzes an image file when asked

## Acceptance Criteria
- User can say "use council mode" and get multi-model implementations
- Gemini handles image/audio/PDF tasks natively
- SKILL.md is a complete reference for the swarm's capabilities
- Council mode is opt-in — default workflow unchanged
- Cost is communicated upfront before council mode starts

## Decisions To Make
- Should council workers use Claude + Gemini, or Claude + Gemini + Codex as workers?
- How to handle synthesis when implementations are architecturally incompatible (can't merge)?
- Should multimodal analysis be a separate MCP tool or integrated into spawn_workers?
