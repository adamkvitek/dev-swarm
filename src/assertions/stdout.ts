/**
 * stdoutContains — regex/string matching on captured stdout.
 *
 * Supports both literal string matching and regex patterns.
 * Used to verify that CLI tool output contains expected content.
 */

import type { AssertionResult } from "./types.js";

export interface StdoutContainsOptions {
  /** Match mode: literal string or regex pattern. Defaults to "string". */
  mode?: "string" | "regex";
  /** Case-insensitive matching. Defaults to false. */
  ignoreCase?: boolean;
  /** Invert the match — assert that stdout does NOT contain the pattern. */
  invertMatch?: boolean;
}

/**
 * Assert that stdout contains (or doesn't contain) a given pattern.
 *
 * @param stdout - Captured stdout string from a CLI run
 * @param pattern - String literal or regex pattern to match
 * @param options - Matching options
 */
export function stdoutContains(
  stdout: string,
  pattern: string,
  options: StdoutContainsOptions = {}
): AssertionResult {
  const { mode = "string", ignoreCase = false, invertMatch = false } = options;
  const name = `stdoutContains(${invertMatch ? "NOT " : ""}"${truncate(pattern, 60)}")`;

  if (!pattern) {
    return {
      passed: false,
      name,
      message: "Pattern must be a non-empty string",
      expected: "non-empty pattern",
      actual: "empty string",
    };
  }

  let found: boolean;
  let matchDetail: string;

  if (mode === "regex") {
    try {
      const flags = ignoreCase ? "i" : "";
      const regex = new RegExp(pattern, flags);
      const match = regex.exec(stdout);
      found = match !== null;
      matchDetail = found
        ? `Matched at index ${match!.index}: "${truncate(match![0], 80)}"`
        : "No regex match found";
    } catch (err) {
      return {
        passed: false,
        name,
        message: `Invalid regex pattern: ${(err as Error).message}`,
        expected: "valid regex",
        actual: pattern,
      };
    }
  } else {
    const haystack = ignoreCase ? stdout.toLowerCase() : stdout;
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    const index = haystack.indexOf(needle);
    found = index !== -1;
    matchDetail = found
      ? `Found at index ${index}`
      : "Literal string not found in stdout";
  }

  const passed = invertMatch ? !found : found;

  return {
    passed,
    name,
    message: passed
      ? invertMatch
        ? `stdout correctly does not contain pattern`
        : `stdout contains expected pattern. ${matchDetail}`
      : invertMatch
        ? `stdout unexpectedly contains pattern. ${matchDetail}`
        : `${matchDetail}`,
    expected: invertMatch ? "pattern absent" : "pattern present",
    actual: found ? "pattern found" : "pattern not found",
  };
}

/**
 * Assert stdout matches multiple patterns. All must pass for the suite to pass.
 */
export function stdoutContainsAll(
  stdout: string,
  patterns: string[],
  options: StdoutContainsOptions = {}
): AssertionResult[] {
  return patterns.map((pattern) => stdoutContains(stdout, pattern, options));
}

/**
 * Assert stdout matches at least one of the given patterns.
 */
export function stdoutContainsAny(
  stdout: string,
  patterns: string[],
  options: StdoutContainsOptions = {}
): AssertionResult {
  const results = patterns.map((pattern) => stdoutContains(stdout, pattern, options));
  const anyPassed = results.some((r) => r.passed);

  return {
    passed: anyPassed,
    name: `stdoutContainsAny(${patterns.length} patterns)`,
    message: anyPassed
      ? `Matched ${results.filter((r) => r.passed).length}/${patterns.length} patterns`
      : `None of ${patterns.length} patterns matched stdout`,
    expected: "at least one pattern match",
    actual: `${results.filter((r) => r.passed).length} matches`,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}
