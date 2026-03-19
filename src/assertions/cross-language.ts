/**
 * Cross-language result validation.
 *
 * Compares outputs from the same code sample run in Python, Java, and C#
 * to detect behavioral inconsistencies between language implementations.
 */

import { spawn } from "node:child_process";
import type {
  AssertionResult,
  CrossLanguageInconsistency,
  CrossLanguageResult,
  LanguageRun,
  SupportedLanguage,
} from "./types.js";

export interface CrossLanguageValidationOptions {
  /** Normalize whitespace before comparing (trim lines, collapse multiple spaces). */
  normalizeWhitespace?: boolean;
  /** Ignore trailing newlines when comparing. Defaults to true. */
  ignoreTrailingNewlines?: boolean;
  /** Custom normalizer applied to stdout before comparison. */
  normalizer?: (stdout: string, language: SupportedLanguage) => string;
  /** Lines to exclude from comparison (e.g., language-specific debug output). */
  excludePatterns?: string[];
}

/**
 * Normalize stdout for cross-language comparison.
 * Strips language-specific artifacts that don't represent behavioral differences.
 */
function normalizeOutput(
  stdout: string,
  language: SupportedLanguage,
  options: CrossLanguageValidationOptions
): string {
  let normalized = stdout;

  if (options.ignoreTrailingNewlines !== false) {
    normalized = normalized.replace(/\n+$/, "");
  }

  if (options.normalizeWhitespace) {
    normalized = normalized
      .split("\n")
      .map((line) => line.trim().replace(/\s+/g, " "))
      .join("\n");
  }

  if (options.excludePatterns) {
    const lines = normalized.split("\n");
    normalized = lines
      .filter((line) => {
        return !options.excludePatterns!.some((pattern) => {
          try {
            return new RegExp(pattern).test(line);
          } catch {
            return line.includes(pattern);
          }
        });
      })
      .join("\n");
  }

  if (options.normalizer) {
    normalized = options.normalizer(normalized, language);
  }

  return normalized;
}

/**
 * Compare runs from different languages for the same sample.
 * Groups runs by sampleId and compares normalized outputs.
 */
export function validateCrossLanguage(
  runs: LanguageRun[],
  options: CrossLanguageValidationOptions = {}
): CrossLanguageResult {
  const results: AssertionResult[] = [];
  const inconsistencies: CrossLanguageInconsistency[] = [];

  // Group runs by sampleId
  const bySample = new Map<string, LanguageRun[]>();
  for (const run of runs) {
    const existing = bySample.get(run.sampleId) ?? [];
    existing.push(run);
    bySample.set(run.sampleId, existing);
  }

  for (const [sampleId, sampleRuns] of bySample) {
    if (sampleRuns.length < 2) {
      results.push({
        passed: true,
        name: `crossLanguage("${sampleId}")`,
        message: `Only ${sampleRuns.length} language run(s) for sample — skipping comparison`,
      });
      continue;
    }

    // Compare exit codes
    const exitCodes = new Map<SupportedLanguage, number>();
    for (const run of sampleRuns) {
      exitCodes.set(run.language, run.exitCode);
    }

    const uniqueExitCodes = new Set(exitCodes.values());
    if (uniqueExitCodes.size > 1) {
      const values: Partial<Record<SupportedLanguage, string>> = {};
      for (const [lang, code] of exitCodes) {
        values[lang] = String(code);
      }
      inconsistencies.push({ field: "exitCode", sampleId, values });
      results.push({
        passed: false,
        name: `crossLanguage("${sampleId}").exitCode`,
        message: `Exit codes differ: ${formatComparison(exitCodes)}`,
        expected: "identical exit codes",
        actual: `${uniqueExitCodes.size} distinct values`,
      });
    } else {
      results.push({
        passed: true,
        name: `crossLanguage("${sampleId}").exitCode`,
        message: `All languages exited with code ${[...uniqueExitCodes][0]}`,
      });
    }

    // Compare normalized stdout
    const normalizedOutputs = new Map<SupportedLanguage, string>();
    for (const run of sampleRuns) {
      normalizedOutputs.set(
        run.language,
        normalizeOutput(run.stdout, run.language, options)
      );
    }

    const uniqueOutputs = new Set(normalizedOutputs.values());
    if (uniqueOutputs.size > 1) {
      const values: Partial<Record<SupportedLanguage, string>> = {};
      for (const [lang, output] of normalizedOutputs) {
        values[lang] = output.length > 200 ? output.slice(0, 200) + "..." : output;
      }
      inconsistencies.push({ field: "stdout", sampleId, values });

      // Find the first pair that differs for a helpful message
      const langs = [...normalizedOutputs.keys()];
      let diffDetail = "";
      for (let i = 0; i < langs.length - 1; i++) {
        for (let j = i + 1; j < langs.length; j++) {
          const a = normalizedOutputs.get(langs[i])!;
          const b = normalizedOutputs.get(langs[j])!;
          if (a !== b) {
            const diffLine = findFirstDifference(a, b);
            diffDetail = `${langs[i]} vs ${langs[j]}: first difference at line ${diffLine.line + 1}`;
            break;
          }
        }
        if (diffDetail) break;
      }

      results.push({
        passed: false,
        name: `crossLanguage("${sampleId}").stdout`,
        message: `Stdout differs across languages. ${diffDetail}`,
        expected: "identical stdout",
        actual: `${uniqueOutputs.size} distinct outputs`,
      });
    } else {
      results.push({
        passed: true,
        name: `crossLanguage("${sampleId}").stdout`,
        message: `All ${sampleRuns.length} language runs produced identical stdout`,
      });
    }

    // Compare stderr (non-empty stderr is a warning, not an inconsistency)
    const stderrByLang = new Map<SupportedLanguage, string>();
    for (const run of sampleRuns) {
      if (run.stderr.trim()) {
        stderrByLang.set(run.language, run.stderr.trim());
      }
    }

    if (stderrByLang.size > 0) {
      const langs = [...stderrByLang.keys()].join(", ");
      results.push({
        passed: true, // stderr is informational, not a failure
        name: `crossLanguage("${sampleId}").stderr`,
        message: `Stderr present for: ${langs} (informational)`,
      });
    }
  }

  const consistent = inconsistencies.length === 0;

  return { consistent, results, inconsistencies };
}

/**
 * Execute a code sample in a given language and capture output.
 */
export function executeLanguageRun(
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeoutMs = options?.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(
        new Error(`Language run timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`)
      );
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    proc.stdin.end();
  });
}

function formatComparison<T>(map: Map<SupportedLanguage, T>): string {
  return [...map.entries()]
    .map(([lang, val]) => `${lang}=${val}`)
    .join(", ");
}

function findFirstDifference(
  a: string,
  b: string
): { line: number; col: number } {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const maxLines = Math.max(linesA.length, linesB.length);

  for (let i = 0; i < maxLines; i++) {
    const lineA = linesA[i] ?? "";
    const lineB = linesB[i] ?? "";
    if (lineA !== lineB) {
      const maxCols = Math.max(lineA.length, lineB.length);
      for (let j = 0; j < maxCols; j++) {
        if (lineA[j] !== lineB[j]) {
          return { line: i, col: j };
        }
      }
      return { line: i, col: 0 };
    }
  }

  return { line: 0, col: 0 };
}
