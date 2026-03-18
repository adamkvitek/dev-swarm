# Verification Results — 2026-03-18

## Environment

| Runtime   | Version             |
|-----------|---------------------|
| Node.js   | >= 22               |
| Python    | 3.14.3              |
| Java/JDK  | OpenJDK 21.0.2 LTS  |
| .NET SDK  | 10.0.103            |
| TypeScript| 5.7+                |

## verify-all.mjs — Cross-Language Pipeline

**Command:** `node verify-all.mjs --all`

### Results by Language

| Language | Samples | Pass | Fail | Skip |
|----------|---------|------|------|------|
| Python   | 2       | 4    | 0    | 0    |
| Java     | 2       | 4    | 0    | 0    |
| C#/.NET  | 2       | 4    | 0    | 0    |

### Cross-Language Validation

| Sample      | exitCode | stdout | Result |
|-------------|----------|--------|--------|
| hello-world | Match    | Match  | PASS   |
| fizzbuzz    | Match    | Match  | PASS   |

**Total: 16/16 PASS, 0 FAIL, 0 SKIP**

All three languages produce identical stdout for both samples. No cross-language inconsistencies detected.

## vitest — Assertion Library & CLI Runner Tests

**Command:** `npx vitest run`

| Test File                                | Tests | Pass | Fail |
|------------------------------------------|-------|------|------|
| src/assertions/__tests__/stdout.test.ts  | 18    | 18   | 0    |
| src/assertions/__tests__/files.test.ts   | 11    | 11   | 0    |
| src/assertions/__tests__/cross-language.test.ts | 16 | 16  | 0    |
| src/agents/__tests__/cli-runner.test.ts  | 13    | 13   | 0    |

**Total: 58/58 PASS, 0 FAIL**

## TypeScript Typecheck

**Command:** `npx tsc --noEmit`
**Result:** Clean — no errors.

## Reviewer Bugs Fixed

1. **OpenClaw guard blocked ALL execution** — Now only blocks host-side. Set `OPENCLAW_VM_CONFIRMED=1` inside a VM to allow. Tested with 6 specific unit tests.

2. **CLI runner stdin left open** — `proc.stdin.end()` now always called, even when no stdin content is provided. Verified with a `cat` hang test (completes in <3s instead of timing out).

3. **Runtime gaps for Java/C#** — `verify-all.mjs` now checks `which` for each runtime before running. Missing runtimes produce a clear skip message with install hints. C# execution simplified to `dotnet run <file.cs>` (requires .NET 10+).

## Remaining Bugs / Notes

- C# execution requires .NET 10+ for bare file support. Older .NET SDKs would need the scaffolded .csproj approach (removed as it hardcoded net8.0 TFM).
- No VB.NET or F# runners yet.
- No certificate/security samples yet.
