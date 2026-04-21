import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

/**
 * Maps tech stack keywords to language standard file names.
 * Case-insensitive matching.
 */
const LANGUAGE_MAP: Record<string, string> = {
  typescript: "typescript",
  ts: "typescript",
  javascript: "typescript", // TS rules are a superset of JS best practices
  js: "typescript",
  react: "typescript",
  node: "typescript",
  "node.js": "typescript",
  nodejs: "typescript",
  nextjs: "typescript",
  "next.js": "typescript",
  angular: "typescript",
  vue: "typescript",
  python: "python",
  py: "python",
  django: "python",
  flask: "python",
  fastapi: "python",
  go: "go",
  golang: "go",
  rust: "rust",
  java: "java",
  spring: "java",
  "spring boot": "java",
  kotlin: "java", // Similar enough for safety rules
  "c#": "csharp",
  csharp: "csharp",
  ".net": "csharp",
  dotnet: "csharp",
  aspnet: "csharp",
  swift: "swift",
  swiftui: "swift",
  ios: "swift",
  ruby: "ruby",
  rails: "ruby",
  "ruby on rails": "ruby",
  c: "c",
  "c++": "cpp",
  cpp: "cpp",
  "c/c++": "cpp",
  cmake: "cpp",
  qt: "cpp",
  embedded: "c",
};

/** Cache loaded files to avoid repeated disk reads */
const cache = new Map<string, string>();
const MAX_CACHE_SIZE = 200;

async function loadFile(path: string): Promise<string | null> {
  if (cache.has(path)) return cache.get(path)!;
  try {
    const content = await readFile(path, "utf-8");
    if (cache.size >= MAX_CACHE_SIZE) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    cache.set(path, content);
    return content;
  } catch {
    return null;
  }
}

/**
 * Load the universal code standards.
 */
export async function loadUniversalStandards(): Promise<string> {
  const content = await loadFile(resolve(PROMPTS_DIR, "code-standards.md"));
  return content ?? "";
}

/**
 * Load the review checklist for the reviewer agent.
 */
export async function loadReviewChecklist(): Promise<string> {
  const content = await loadFile(resolve(PROMPTS_DIR, "review-checklist.md"));
  return content ?? "";
}

/**
 * Detect languages from a tech stack array and load their standards.
 * Returns combined standards text for all detected languages.
 */
export async function loadLanguageStandards(techStack: string[]): Promise<string> {
  const detectedLanguages = new Set<string>();

  for (const tech of techStack) {
    const key = tech.toLowerCase().trim();
    const lang = LANGUAGE_MAP[key];
    if (lang) detectedLanguages.add(lang);
  }

  if (detectedLanguages.size === 0) {
    log.worker.info({ techStack }, "No language-specific standards matched");
    return "";
  }

  const parts: string[] = [];
  for (const lang of detectedLanguages) {
    const content = await loadFile(resolve(PROMPTS_DIR, "standards", `${lang}.md`));
    if (content) {
      parts.push(content);
    }
  }

  log.worker.info(
    { languages: Array.from(detectedLanguages) },
    "Loaded language-specific standards",
  );

  return parts.join("\n\n");
}

/**
 * Well-known project convention files.
 * If found in the target repo, their content is injected into the worker prompt
 * so the agent follows the project's own standards (which take priority over ours).
 */
const PROJECT_CONVENTION_FILES = [
  "CONTRIBUTING.md",
  "CLAUDE.md",
  ".editorconfig",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.json",
  "biome.json",
  "pyproject.toml",       // Python: ruff/black/mypy config
  ".golangci.yml",        // Go: linter config
  "rustfmt.toml",         // Rust: format config
  "clippy.toml",          // Rust: lint config
  ".rubocop.yml",         // Ruby: linter config
  ".swiftlint.yml",       // Swift: linter config
  "STYLE_GUIDE.md",
  "CODE_STYLE.md",
  "docs/CONTRIBUTING.md",
];

/**
 * Scan the target repository for existing project conventions.
 * Returns a summary of what was found so the worker can follow existing patterns.
 */
export async function loadProjectConventions(repoPath: string): Promise<string> {
  const found: Array<{ file: string; content: string }> = [];

  for (const file of PROJECT_CONVENTION_FILES) {
    const content = await loadFile(resolve(repoPath, file));
    if (content) {
      // Truncate large files — we just need the gist, not the full eslint config
      const truncated = content.length > 2000
        ? content.slice(0, 2000) + "\n... (truncated)"
        : content;
      found.push({ file, content: truncated });
    }
  }

  if (found.length === 0) return "";

  log.worker.info(
    { files: found.map((f) => f.file) },
    "Found project convention files",
  );

  const parts = [
    "# Project-Specific Conventions (HIGHEST PRIORITY)",
    "",
    "The following files were found in the target repository.",
    "**Follow these conventions over any generic rules.** The project's own standards always win.",
    "",
  ];

  for (const { file, content } of found) {
    parts.push(`## ${file}`);
    parts.push("```");
    parts.push(content);
    parts.push("```");
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Build the full standards prompt for a worker agent.
 * Priority order: project conventions > language-specific > universal.
 * Project's own standards always override generic rules.
 */
export async function buildWorkerStandards(
  techStack: string[],
  repoPath?: string,
): Promise<string> {
  const [universal, language, project] = await Promise.all([
    loadUniversalStandards(),
    loadLanguageStandards(techStack),
    repoPath ? loadProjectConventions(repoPath) : Promise.resolve(""),
  ]);

  const parts: string[] = [];

  // Project conventions first — they have highest priority
  if (project) parts.push(project);

  // Then our standards as baseline
  if (universal) parts.push(universal);
  if (language) parts.push(language);

  return parts.join("\n\n---\n\n");
}
