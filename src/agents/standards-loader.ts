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
};

/** Cache loaded files to avoid repeated disk reads */
const cache = new Map<string, string>();

async function loadFile(path: string): Promise<string | null> {
  if (cache.has(path)) return cache.get(path)!;
  try {
    const content = await readFile(path, "utf-8");
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
 * Build the full standards prompt for a worker agent.
 * Combines universal rules + language-specific rules based on tech stack.
 */
export async function buildWorkerStandards(techStack: string[]): Promise<string> {
  const [universal, language] = await Promise.all([
    loadUniversalStandards(),
    loadLanguageStandards(techStack),
  ]);

  const parts = [universal];
  if (language) parts.push(language);
  return parts.join("\n\n---\n\n");
}
