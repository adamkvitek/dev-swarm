import { describe, it, expect } from "vitest";
import { validateCrossLanguage, executeLanguageRun } from "../cross-language.js";
import type { LanguageRun } from "../types.js";

function makeRun(
  overrides: Partial<LanguageRun> = {}
): LanguageRun {
  return {
    language: "python",
    sampleId: "test-sample",
    stdout: "Hello World\n",
    stderr: "",
    exitCode: 0,
    outputFiles: [],
    ...overrides,
  };
}

describe("validateCrossLanguage", () => {
  it("should report consistent when all outputs match", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", stdout: "Hello\n" }),
      makeRun({ language: "java", stdout: "Hello\n" }),
      makeRun({ language: "csharp", stdout: "Hello\n" }),
    ];

    const result = validateCrossLanguage(runs);
    expect(result.consistent).toBe(true);
    expect(result.inconsistencies).toHaveLength(0);
    expect(result.results.every((r) => r.passed)).toBe(true);
  });

  it("should detect exit code inconsistencies", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", exitCode: 0 }),
      makeRun({ language: "java", exitCode: 1 }),
    ];

    const result = validateCrossLanguage(runs);
    expect(result.consistent).toBe(false);
    const exitInc = result.inconsistencies.find((i) => i.field === "exitCode");
    expect(exitInc).toBeDefined();
    expect(exitInc!.values.python).toBe("0");
    expect(exitInc!.values.java).toBe("1");
  });

  it("should detect stdout inconsistencies", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", stdout: "42\n" }),
      makeRun({ language: "java", stdout: "43\n" }),
    ];

    const result = validateCrossLanguage(runs);
    expect(result.consistent).toBe(false);
    const stdoutInc = result.inconsistencies.find((i) => i.field === "stdout");
    expect(stdoutInc).toBeDefined();
  });

  it("should ignore trailing newlines by default", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", stdout: "Hello\n" }),
      makeRun({ language: "java", stdout: "Hello\n\n\n" }),
    ];

    const result = validateCrossLanguage(runs);
    expect(result.consistent).toBe(true);
  });

  it("should normalize whitespace when option is set", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", stdout: "hello   world\n" }),
      makeRun({ language: "java", stdout: "hello world\n" }),
    ];

    const result = validateCrossLanguage(runs, { normalizeWhitespace: true });
    expect(result.consistent).toBe(true);
  });

  it("should exclude patterns from comparison", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", stdout: "Result: 42\nDEBUG: python trace\n" }),
      makeRun({ language: "java", stdout: "Result: 42\nDEBUG: java trace\n" }),
    ];

    const result = validateCrossLanguage(runs, {
      excludePatterns: ["^DEBUG:"],
    });
    expect(result.consistent).toBe(true);
  });

  it("should apply custom normalizer", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", stdout: "result=42.0\n" }),
      makeRun({ language: "java", stdout: "result=42\n" }),
    ];

    const result = validateCrossLanguage(runs, {
      normalizer: (stdout) => stdout.replace(/(\d+)\.0/g, "$1"),
    });
    expect(result.consistent).toBe(true);
  });

  it("should skip comparison for single-language samples", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", sampleId: "solo" }),
    ];

    const result = validateCrossLanguage(runs);
    expect(result.consistent).toBe(true);
    expect(result.results[0].message).toContain("skipping comparison");
  });

  it("should group runs by sampleId and compare independently", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", sampleId: "a", stdout: "1\n" }),
      makeRun({ language: "java", sampleId: "a", stdout: "1\n" }),
      makeRun({ language: "python", sampleId: "b", stdout: "2\n" }),
      makeRun({ language: "java", sampleId: "b", stdout: "3\n" }), // mismatch
    ];

    const result = validateCrossLanguage(runs);
    expect(result.consistent).toBe(false);
    expect(result.inconsistencies).toHaveLength(1);
    expect(result.inconsistencies[0].sampleId).toBe("b");
  });

  it("should report stderr as informational (not failure)", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", stdout: "ok\n", stderr: "warning: something" }),
      makeRun({ language: "java", stdout: "ok\n", stderr: "" }),
    ];

    const result = validateCrossLanguage(runs);
    expect(result.consistent).toBe(true);
    const stderrResult = result.results.find((r) => r.name.includes("stderr"));
    expect(stderrResult?.passed).toBe(true);
    expect(stderrResult?.message).toContain("informational");
  });

  it("should identify first line of difference in stdout", () => {
    const runs: LanguageRun[] = [
      makeRun({ language: "python", stdout: "line1\nline2\nline3\n" }),
      makeRun({ language: "java", stdout: "line1\nline2\ndifferent\n" }),
    ];

    const result = validateCrossLanguage(runs);
    const stdoutResult = result.results.find(
      (r) => r.name.includes("stdout") && !r.passed
    );
    expect(stdoutResult?.message).toContain("line 3");
  });
});

describe("executeLanguageRun", () => {
  it("should capture stdout from a simple command", async () => {
    const result = await executeLanguageRun("echo", ["hello"], {
      timeoutMs: 5_000,
    });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("should capture stderr", async () => {
    const result = await executeLanguageRun(
      "sh",
      ["-c", "echo error >&2"],
      { timeoutMs: 5_000 }
    );
    expect(result.stderr.trim()).toBe("error");
  });

  it("should capture non-zero exit codes", async () => {
    const result = await executeLanguageRun("sh", ["-c", "exit 42"], {
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(42);
  });

  it("should reject on timeout", async () => {
    await expect(
      executeLanguageRun("sleep", ["10"], { timeoutMs: 100 })
    ).rejects.toThrow("timed out");
  });

  it("should reject when command does not exist", async () => {
    await expect(
      executeLanguageRun("nonexistent-cmd-xyz", [], { timeoutMs: 5_000 })
    ).rejects.toThrow("Failed to spawn");
  });
});
