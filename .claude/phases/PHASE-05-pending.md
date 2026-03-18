# Phase 05 — Multi-channel, Persistence, Production Hardening
Status: PENDING

## Goal
Production-ready multi-channel bot with graceful shutdown, session persistence, and cleanup of legacy code.

## Tasks
- [ ] Multi-channel session management with isolation
- [ ] Graceful shutdown — save active sessions, drain message queue
- [ ] Session persistence across bot restarts (save/restore session IDs)
- [ ] Discord rate limiting (message queue with backoff)
- [ ] Error recovery — auto-restart sessions on CLI failure
- [ ] Delete legacy files: old discord-bot.ts, old pipeline.ts, old cto.ts state machine code
- [ ] Structured logging (cherry-pick from wip/agent-chaos branch if useful)
- [ ] Health check endpoint
- [ ] Portable config — easy to move to another machine (ENV-based, no hardcoded paths)

## Acceptance Criteria
- Bot handles multiple channels simultaneously without interference
- Bot survives restarts without losing conversation context
- Legacy custom state machine code is fully removed
- Structured JSON logging for all events
- Can be deployed on a different machine by setting environment variables
