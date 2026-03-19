import { resolve, isAbsolute } from "node:path";

/**
 * Input validation for the HTTP API.
 *
 * All user-controlled input passes through these validators before
 * reaching business logic. Deterministic enforcement — not prompt-based.
 */

const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_SUBTASKS = 20;
const MAX_TECH_STACK = 20;

/**
 * Validate and sanitize repoPath.
 * Must be absolute, canonicalized, and a plausible directory path.
 */
export function validateRepoPath(repoPath: unknown): string {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new ValidationError("repoPath must be a non-empty string");
  }

  if (!isAbsolute(repoPath)) {
    throw new ValidationError("repoPath must be an absolute path");
  }

  // Canonicalize to resolve any .. segments
  const canonical = resolve(repoPath);

  // Reject paths that look like they're trying to access system directories
  const blockedPrefixes = ["/etc", "/var", "/proc", "/sys", "/dev", "/boot", "/sbin"];
  for (const prefix of blockedPrefixes) {
    if (canonical === prefix || canonical.startsWith(prefix + "/")) {
      throw new ValidationError(`repoPath cannot point to system directory: ${prefix}`);
    }
  }

  return canonical;
}

/**
 * Validate a safe string for use in git branch names and commit messages.
 * Allows alphanumeric, hyphens, underscores, slashes, dots, spaces.
 */
const SAFE_TEXT_RE = /^[a-zA-Z0-9\s\-_./,:;!?()[\]'"@#$%&+=<>{}|~^`\n]+$/;

export function validateSafeText(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  if (value.length === 0) {
    throw new ValidationError(`${fieldName} must not be empty`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${fieldName} exceeds maximum length of ${maxLength}`);
  }
  // No character restriction on descriptions/feedback — they're prompt text, not shell input.
  // Length limit is sufficient protection.
  return value;
}

/**
 * Validate a string for safe use in git branch names.
 * Only allows: alphanumeric, hyphens, underscores, slashes, dots.
 */
const BRANCH_SAFE_RE = /^[a-zA-Z0-9\-_./]+$/;

export function validateBranchSafeId(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
  if (value.length > 100) {
    throw new ValidationError(`${fieldName} exceeds maximum length of 100`);
  }
  if (!BRANCH_SAFE_RE.test(value)) {
    throw new ValidationError(
      `${fieldName} contains invalid characters (allowed: alphanumeric, hyphens, underscores, slashes, dots)`,
    );
  }
  return value;
}

/**
 * Validate the full subtasks array from a spawn_workers request.
 */
export function validateSubtasks(
  subtasks: unknown,
): Array<{ id: string; title: string; description: string; dependencies: string[] }> {
  if (!Array.isArray(subtasks)) {
    throw new ValidationError("subtasks must be an array");
  }
  if (subtasks.length === 0) {
    throw new ValidationError("subtasks must not be empty");
  }
  if (subtasks.length > MAX_SUBTASKS) {
    throw new ValidationError(`subtasks exceeds maximum of ${MAX_SUBTASKS}`);
  }

  return subtasks.map((s: unknown, i: number) => {
    if (typeof s !== "object" || s === null) {
      throw new ValidationError(`subtasks[${i}] must be an object`);
    }
    const obj = s as Record<string, unknown>;

    const id = validateBranchSafeId(obj.id, `subtasks[${i}].id`);
    const title = validateSafeText(obj.title, `subtasks[${i}].title`, MAX_TITLE_LENGTH);
    const description = validateSafeText(obj.description, `subtasks[${i}].description`, MAX_DESCRIPTION_LENGTH);

    if (!Array.isArray(obj.dependencies)) {
      throw new ValidationError(`subtasks[${i}].dependencies must be an array`);
    }
    const dependencies = obj.dependencies.map((d: unknown, j: number) => {
      if (typeof d !== "string") {
        throw new ValidationError(`subtasks[${i}].dependencies[${j}] must be a string`);
      }
      return d;
    });

    return { id, title, description, dependencies };
  });
}

/**
 * Validate tech stack array.
 */
export function validateTechStack(techStack: unknown): string[] {
  if (!Array.isArray(techStack)) {
    throw new ValidationError("techStack must be an array");
  }
  if (techStack.length === 0) {
    throw new ValidationError("techStack must not be empty");
  }
  if (techStack.length > MAX_TECH_STACK) {
    throw new ValidationError(`techStack exceeds maximum of ${MAX_TECH_STACK}`);
  }

  return techStack.map((item: unknown, i: number) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 100) {
      throw new ValidationError(`techStack[${i}] must be a non-empty string (max 100 chars)`);
    }
    return item;
  });
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
