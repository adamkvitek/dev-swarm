/**
 * Assertion library for verifying agent outputs.
 *
 * Provides three assertion categories:
 * - stdout: Pattern matching on captured CLI output
 * - files: Glob-based file existence validation
 * - crossLanguage: Cross-language output consistency checks
 */

export type {
  AssertionResult,
  AssertionSuite,
  SupportedLanguage,
  LanguageRun,
  CrossLanguageInconsistency,
  CrossLanguageResult,
  JavaRunner,
  SampleAssertion,
  LanguageExpectation,
  SampleExpectation,
  SampleExpectationsFile,
} from "./types.js";

export { LANGUAGE_COMMANDS } from "./types.js";

export {
  stdoutContains,
  stdoutContainsAll,
  stdoutContainsAny,
  type StdoutContainsOptions,
} from "./stdout.js";

export {
  multiFileExists,
  fileExists,
  type MultiFileExistsOptions,
} from "./files.js";

export {
  validateCrossLanguage,
  executeLanguageRun,
  type CrossLanguageValidationOptions,
} from "./cross-language.js";
