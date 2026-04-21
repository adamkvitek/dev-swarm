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

## Security — OWASP Top 10 + AI-Specific (AI Code Is 2.74x More Vulnerable)

8. **Auth before logic.** Authentication enforced before any business logic executes. Unauthenticated requests cannot reach backend logic.
9. **Authorization on every object.** Broken access control is OWASP #1. Check: can user A access user B's data? Are IDs guessable? (IDOR/BOLA)
10. **No invented dependencies.** Every import/require points to a real, verified package. AI hallucinates package names ("slopsquatting").
11. **Input validated against injection.** SQL injection (parameterized queries), XSS (output encoding), command injection (no shell interpolation), SSRF (URL allowlisting).
12. **No insecure deserialization.** User-controlled data never passed to `eval()`, `pickle.loads()`, `JSON.parse()` of untrusted HTML, or `unserialize()`.
13. **CSRF protection on state-changing endpoints.** POST/PUT/DELETE endpoints require CSRF tokens or same-origin validation.
14. **Rate limiting present.** Endpoints accepting external input have abuse protection.
15. **Error messages don't leak internals.** No stack traces, DB schemas, file paths, or SQL queries exposed to clients.
16. **Logging doesn't contain sensitive data.** No passwords, tokens, PII, or credit card numbers in log statements.
17. **Security headers present.** CSP, HSTS, X-Content-Type-Options, X-Frame-Options where applicable.

## Memory Safety (C, C++, Rust, Unsafe Code)

18. **No buffer overflows.** Every array access is bounds-checked. Use safe alternatives (snprintf, strncpy, std::vector).
19. **No use-after-free / double-free.** Freed pointers set to NULL. Smart pointers used where possible. Ownership is clear.
20. **No uninitialized variables.** All variables initialized at declaration. Structs zero-initialized.
21. **`unsafe` blocks justified.** Every `unsafe` (Rust) or raw pointer operation (C/C++) has a comment explaining why it's safe.

## Code Quality

22. **No empty catch blocks.** Every caught error is logged, wrapped, or rethrown.
23. **No `any` / generic catches.** Specific types used throughout.
24. **Functions under 30 lines.** Longer functions likely do too much.
25. **Files under 300 lines.** Longer files likely have mixed responsibilities.
26. **Nesting under 3 levels.** Deep nesting indicates missing early returns or extraction.
27. **Interfaces are narrow.** Functions accept only what they need.

## Testing Quality

28. **Tests cover error cases, not just happy path.** What happens on invalid input? Network failure? Timeout?
29. **Tests are independent.** No test depends on another test's state.
30. **Test names describe behavior.** `should return null when user not found` — not `test1`.
31. **No mocking of things you own.** Test the real code. Mock only external dependencies.

## AI-Specific Red Flags

32. **Safety checks not removed.** AI sometimes removes validation to "fix" errors. Verify checks are still present.
33. **No over-engineering.** Simple tasks don't need design patterns, factories, or abstraction layers.
34. **No copy-paste with mutations.** Repetitive code with slight variations = bugs. Should be abstracted.

## Project Conventions

35. **Follows existing project patterns.** If the repo has a CONTRIBUTING.md, .eslintrc, or style guide — the code matches it, not our generic standards.
