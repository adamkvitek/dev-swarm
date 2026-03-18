/**
 * multiFileExists — validate multiple output files with glob patterns.
 *
 * Checks that files matching given glob patterns exist in a base directory.
 * Uses Node.js fs.glob (available in Node 22+).
 */

import { stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { AssertionResult } from "./types.js";

export interface MultiFileExistsOptions {
  /** Base directory to resolve patterns against. */
  basePath: string;
  /** Glob patterns to match. Each pattern must match at least one file. */
  patterns: string[];
  /** Minimum number of total files expected across all patterns. Defaults to patterns.length. */
  minFiles?: number;
  /** Maximum number of total files expected. No limit if omitted. */
  maxFiles?: number;
}

/**
 * Assert that files matching each glob pattern exist in the given directory.
 * Each pattern must match at least one file for the assertion to pass.
 */
export async function multiFileExists(
  options: MultiFileExistsOptions
): Promise<AssertionResult[]> {
  const { basePath, patterns, minFiles, maxFiles } = options;
  const results: AssertionResult[] = [];
  let totalMatched = 0;

  // Verify basePath exists
  try {
    const stats = await stat(basePath);
    if (!stats.isDirectory()) {
      return [
        {
          passed: false,
          name: "multiFileExists(basePath)",
          message: `basePath is not a directory: ${basePath}`,
          expected: "directory",
          actual: "file or other",
        },
      ];
    }
  } catch {
    return [
      {
        passed: false,
        name: "multiFileExists(basePath)",
        message: `basePath does not exist: ${basePath}`,
        expected: "existing directory",
        actual: "not found",
      },
    ];
  }

  for (const pattern of patterns) {
    const matched: string[] = [];
    const fullPattern = resolve(basePath, pattern);

    try {
      for await (const entry of glob(fullPattern)) {
        matched.push(relative(basePath, entry));
      }
    } catch (err) {
      results.push({
        passed: false,
        name: `multiFileExists("${pattern}")`,
        message: `Glob error: ${(err as Error).message}`,
        expected: "matching files",
        actual: "glob error",
      });
      continue;
    }

    totalMatched += matched.length;
    const passed = matched.length > 0;

    results.push({
      passed,
      name: `multiFileExists("${pattern}")`,
      message: passed
        ? `Found ${matched.length} file(s): ${matched.slice(0, 5).join(", ")}${matched.length > 5 ? ` (+${matched.length - 5} more)` : ""}`
        : `No files matched pattern "${pattern}" in ${basePath}`,
      expected: "at least 1 matching file",
      actual: `${matched.length} files`,
    });
  }

  // Check total file count bounds
  if (minFiles !== undefined && totalMatched < minFiles) {
    results.push({
      passed: false,
      name: "multiFileExists(minFiles)",
      message: `Expected at least ${minFiles} total files, found ${totalMatched}`,
      expected: `>= ${minFiles}`,
      actual: `${totalMatched}`,
    });
  }

  if (maxFiles !== undefined && totalMatched > maxFiles) {
    results.push({
      passed: false,
      name: "multiFileExists(maxFiles)",
      message: `Expected at most ${maxFiles} total files, found ${totalMatched}`,
      expected: `<= ${maxFiles}`,
      actual: `${totalMatched}`,
    });
  }

  return results;
}

/**
 * Assert that a single file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<AssertionResult> {
  try {
    await stat(filePath);
    return {
      passed: true,
      name: `fileExists("${filePath}")`,
      message: `File exists: ${filePath}`,
    };
  } catch {
    return {
      passed: false,
      name: `fileExists("${filePath}")`,
      message: `File not found: ${filePath}`,
      expected: "file exists",
      actual: "not found",
    };
  }
}
