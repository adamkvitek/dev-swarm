# Code Review Checklist

Use this checklist when reviewing code. Check every item. Score each criterion 1-10.

## Must-Check (Every Review)

1. **Does the code match the task description?** Read the task first, then verify the code delivers it.
2. **Are all error paths handled?** Follow every function call that can fail. What happens on error? Is it logged? Propagated? Silently swallowed?
3. **Is there authorization on data access?** Every endpoint and data path. This is the #1 AI-generated code vulnerability.
4. **Is input validated at boundaries?** All external data sanitized before processing. Check for injection (SQL, XSS, command).
5. **Are there tests?** Bug fixes have regression tests. New features have happy-path AND error-path tests.
6. **No hardcoded secrets?** Scan for API keys, passwords, tokens, emails in code and test fixtures.
7. **Are null/nil/None cases handled?** Every nullable value access, optional field, map lookup.

## Security (AI Code Is 2.74x More Likely To Have Vulnerabilities)

8. **Auth before logic.** Authentication enforced before any business logic executes.
9. **No invented dependencies.** Every import/require points to a real, verified package.
10. **Rate limiting present.** Endpoints that accept external input have abuse protection.
11. **Error messages don't leak internals.** No stack traces, DB schemas, or file paths exposed to clients.
12. **Logging doesn't contain sensitive data.** No passwords, tokens, or PII in log statements.

## Code Quality

13. **No empty catch blocks.** Every caught error is logged, wrapped, or rethrown.
14. **No `any` / generic catches.** Specific types used throughout.
15. **Functions under 30 lines.** Longer functions likely do too much.
16. **Files under 300 lines.** Longer files likely have mixed responsibilities.
17. **Nesting under 3 levels.** Deep nesting indicates missing early returns or extraction.
18. **Interfaces are narrow.** Functions accept only what they need.

## Testing Quality

19. **Tests cover error cases, not just happy path.** What happens on invalid input? Network failure? Timeout?
20. **Tests are independent.** No test depends on another test's state.
21. **Test names describe behavior.** `should return null when user not found` — not `test1`.
22. **No mocking of things you own.** Test the real code. Mock only external dependencies.

## AI-Specific Red Flags

23. **Safety checks not removed.** AI sometimes removes validation to "fix" errors. Verify checks are still present.
24. **No over-engineering.** Simple tasks don't need design patterns, factories, or abstraction layers.
25. **No copy-paste with mutations.** Repetitive code with slight variations = bugs. Should be abstracted.
