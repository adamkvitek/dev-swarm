/**
 * Core types for the assertion library.
 * Used by verify-all.mjs and the review pipeline to validate agent outputs.
 */

export interface AssertionResult {
  passed: boolean;
  name: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface AssertionSuite {
  name: string;
  results: AssertionResult[];
  passed: boolean;
  durationMs: number;
}

export type SupportedLanguage = "python" | "java" | "csharp";

export interface LanguageRun {
  language: SupportedLanguage;
  sampleId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  outputFiles: string[];
}

export interface CrossLanguageInconsistency {
  field: string;
  sampleId: string;
  values: Partial<Record<SupportedLanguage, string>>;
}

export interface CrossLanguageResult {
  consistent: boolean;
  results: AssertionResult[];
  inconsistencies: CrossLanguageInconsistency[];
}

export const LANGUAGE_COMMANDS: Record<SupportedLanguage, { compile?: string; run: string; extension: string }> = {
  python: { run: "python3", extension: ".py" },
  java: { compile: "javac", run: "java", extension: ".java" },
  csharp: { run: "dotnet run", extension: ".cs" },
};

/** Runner mode for Java samples. "auto" detects pom.xml to choose Maven vs javac. */
export type JavaRunner = "auto" | "maven" | "javac";

/** Assertion definition from sample-expectations.json. */
export interface SampleAssertion {
  type?: "stdoutContains" | "exitCode" | "stdoutContainsAll" | "stdoutContainsAny";
  pattern?: string;
  patterns?: string[];
  mode?: "string" | "regex";
  ignoreCase?: boolean;
  invertMatch?: boolean;
  expectedExitCode?: number;
}

/** Per-language expectation overrides for a sample. */
export interface LanguageExpectation {
  skip?: boolean;
  skipReason?: string;
  timeoutMs?: number;
  assertions?: SampleAssertion[];
  expectedExitCode?: number;
  /** For Java: force "maven" or "javac" runner. Default "auto" detects pom.xml. */
  runner?: JavaRunner;
}

/** Top-level expectation for a sample, keyed by language or "*" for all. */
export type SampleExpectation = Record<string, LanguageExpectation>;

/** Schema for sample-expectations.json. */
export type SampleExpectationsFile = Record<string, SampleExpectation>;
