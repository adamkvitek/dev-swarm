# Code Standards — Universal Rules

These rules apply to ALL code you write, regardless of language.

## Three Core Principles

1. **Specs are written, not implicit.** Every behavior's intent is documented — as comments in the code or separate documents. Never leave intent in your head.
2. **Narrow interfaces.** Design interfaces as narrow as possible. Accept only what you need, expose only what callers need. Small interfaces minimize coupling.
3. **Automated tests for everything.** Every feature has tests. Every bug fix has a regression test. No exceptions.

## Error Handling

- Never swallow errors silently. Every error must be logged, propagated, or explicitly handled with a documented reason.
- Use specific error types, not generic catches. `catch (error)` / `except Exception` hides bugs.
- Error messages must include context: what operation failed, what input caused it, what was expected.
- Never use exceptions for control flow. Check conditions explicitly.

## Naming

- Booleans read as yes/no questions: `isActive`, `hasPermission`, `canDelete`.
- Functions describe the action: `getUserById` returns a user, `validateEmail` returns a boolean.
- Distinguish nullable returns: `findUser` may return null, `getUser` must return a value or throw.
- Collections are plural: `users`, not `userList` or `userData`.

## Interface Design

- Accept the narrowest type, return the richest type.
- One behavior per interface. Large interfaces couple unrelated consumers.
- Make illegal states unrepresentable. Use discriminated unions / sum types so the type system prevents invalid states.
- Default to immutable. Require explicit opt-in to mutability.

## Testing

- Every bug fix ships with a regression test that fails before the fix and passes after.
- Test behavior, not implementation. Tests that break when you refactor internals are coupling tests.
- Unhappy paths get equal or greater coverage than happy paths.
- Test names describe behavior: `should return null when user does not exist`.

## Security

- Never trust input. All external input must be validated and sanitized.
- Authorization checks on every endpoint. Implement auth BEFORE business logic, not after.
- No secrets in code. Use environment variables or secret managers.
- Principle of least privilege. Every component gets minimum permissions required.
- Rate limiting and resource bounds on every endpoint that accepts external input.

## What NOT To Do (AI Anti-Patterns)

These are documented failure modes of AI-generated code. Avoid them:

- Do NOT remove safety checks to "fix" errors. Fix the underlying issue.
- Do NOT generate happy-path-only error handling. Handle the error cases.
- Do NOT swallow exceptions with empty catch blocks.
- Do NOT import packages that don't exist. Verify every dependency.
- Do NOT add auth/security only when asked. Add it proactively.
- Do NOT over-engineer simple tasks with unnecessary abstractions.
- Do NOT write superficial tests that only test one example input.
