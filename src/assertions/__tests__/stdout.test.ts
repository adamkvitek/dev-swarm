import { describe, it, expect } from "vitest";
import {
  stdoutContains,
  stdoutContainsAll,
  stdoutContainsAny,
} from "../stdout.js";

describe("stdoutContains", () => {
  const sampleOutput = "Hello, World!\nLine 2: result=42\nDone.";

  it("should find a literal string match", () => {
    const result = stdoutContains(sampleOutput, "Hello, World!");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Found at index 0");
  });

  it("should fail when literal string is not found", () => {
    const result = stdoutContains(sampleOutput, "missing text");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("should find a regex pattern match", () => {
    const result = stdoutContains(sampleOutput, "result=\\d+", {
      mode: "regex",
    });
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Matched at index");
  });

  it("should fail when regex does not match", () => {
    const result = stdoutContains(sampleOutput, "^Done$", { mode: "regex" });
    // multiline flag not set, so ^Done$ won't match within a multi-line string
    expect(result.passed).toBe(false);
  });

  it("should support case-insensitive literal matching", () => {
    const result = stdoutContains(sampleOutput, "hello, world!", {
      ignoreCase: true,
    });
    expect(result.passed).toBe(true);
  });

  it("should support case-insensitive regex matching", () => {
    const result = stdoutContains(sampleOutput, "HELLO", {
      mode: "regex",
      ignoreCase: true,
    });
    expect(result.passed).toBe(true);
  });

  it("should support inverted matching (assert absence)", () => {
    const result = stdoutContains(sampleOutput, "ERROR", { invertMatch: true });
    expect(result.passed).toBe(true);
    expect(result.message).toContain("does not contain");
  });

  it("should fail inverted match when pattern is found", () => {
    const result = stdoutContains(sampleOutput, "Hello", { invertMatch: true });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("unexpectedly");
  });

  it("should fail with empty pattern", () => {
    const result = stdoutContains(sampleOutput, "");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("non-empty");
  });

  it("should fail with invalid regex pattern", () => {
    const result = stdoutContains(sampleOutput, "[invalid(", {
      mode: "regex",
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Invalid regex");
  });

  it("should work with empty stdout", () => {
    const result = stdoutContains("", "anything");
    expect(result.passed).toBe(false);
  });

  it("should truncate long patterns in the name", () => {
    const longPattern = "a".repeat(100);
    const result = stdoutContains(sampleOutput, longPattern);
    expect(result.name.length).toBeLessThan(120);
  });
});

describe("stdoutContainsAll", () => {
  const output = "foo bar baz";

  it("should pass when all patterns match", () => {
    const results = stdoutContainsAll(output, ["foo", "bar", "baz"]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("should fail individual assertions when patterns are missing", () => {
    const results = stdoutContainsAll(output, ["foo", "missing", "baz"]);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[2].passed).toBe(true);
  });

  it("should return empty array for empty patterns list", () => {
    const results = stdoutContainsAll(output, []);
    expect(results).toHaveLength(0);
  });
});

describe("stdoutContainsAny", () => {
  const output = "foo bar baz";

  it("should pass when at least one pattern matches", () => {
    const result = stdoutContainsAny(output, ["missing", "bar", "nope"]);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("1/3");
  });

  it("should fail when no patterns match", () => {
    // "z" is in "baz", so use patterns that truly don't match
    const result = stdoutContainsAny(output, ["xx", "yy", "zz"]);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("None of 3");
  });

  it("should count multiple matches", () => {
    const result = stdoutContainsAny(output, ["foo", "bar"]);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("2/2");
  });
});
