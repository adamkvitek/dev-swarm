import { describe, it, expect } from "vitest";
import {
  validateRepoPath,
  validateSubtasks,
  validateTechStack,
  validateSafeText,
  validateBranchSafeId,
  ValidationError,
} from "../validation.js";

describe("validateRepoPath", () => {
  it("should accept valid absolute paths", () => {
    expect(validateRepoPath("/Users/adam/projects/my-app")).toBe("/Users/adam/projects/my-app");
    expect(validateRepoPath("/home/user/repo")).toBe("/home/user/repo");
    expect(validateRepoPath("/tmp/test-repo")).toBe("/tmp/test-repo");
  });

  it("should reject relative paths", () => {
    expect(() => validateRepoPath("relative/path")).toThrow(ValidationError);
    expect(() => validateRepoPath("./relative")).toThrow(ValidationError);
    expect(() => validateRepoPath("../escape")).toThrow(ValidationError);
  });

  it("should reject non-string values", () => {
    expect(() => validateRepoPath(null)).toThrow(ValidationError);
    expect(() => validateRepoPath(undefined)).toThrow(ValidationError);
    expect(() => validateRepoPath(123)).toThrow(ValidationError);
    expect(() => validateRepoPath("")).toThrow(ValidationError);
  });

  it("should reject system directories", () => {
    expect(() => validateRepoPath("/etc")).toThrow(ValidationError);
    expect(() => validateRepoPath("/etc/passwd")).toThrow(ValidationError);
    expect(() => validateRepoPath("/proc/self")).toThrow(ValidationError);
    expect(() => validateRepoPath("/sys/kernel")).toThrow(ValidationError);
    expect(() => validateRepoPath("/var/log")).toThrow(ValidationError);
    expect(() => validateRepoPath("/dev/null")).toThrow(ValidationError);
    expect(() => validateRepoPath("/boot/vmlinuz")).toThrow(ValidationError);
    expect(() => validateRepoPath("/sbin/init")).toThrow(ValidationError);
  });

  it("should canonicalize paths with .. segments", () => {
    // /Users/adam/../bob → /Users/bob (canonicalized, no traversal)
    expect(validateRepoPath("/Users/adam/../bob/repo")).toBe("/Users/bob/repo");
  });

  it("should not block paths that start with blocked prefixes in directory names", () => {
    // /home/user/etc-config is NOT /etc
    expect(validateRepoPath("/home/user/etc-config")).toBe("/home/user/etc-config");
  });
});

describe("validateBranchSafeId", () => {
  it("should accept valid IDs", () => {
    expect(validateBranchSafeId("subtask-1", "id")).toBe("subtask-1");
    expect(validateBranchSafeId("abc123", "id")).toBe("abc123");
    expect(validateBranchSafeId("feat/my-task", "id")).toBe("feat/my-task");
    expect(validateBranchSafeId("a.b.c", "id")).toBe("a.b.c");
    expect(validateBranchSafeId("under_score", "id")).toBe("under_score");
  });

  it("should reject IDs with shell-dangerous characters", () => {
    expect(() => validateBranchSafeId("id; rm -rf /", "id")).toThrow(ValidationError);
    expect(() => validateBranchSafeId("id && echo pwned", "id")).toThrow(ValidationError);
    expect(() => validateBranchSafeId("id | cat /etc/passwd", "id")).toThrow(ValidationError);
    expect(() => validateBranchSafeId("id$(whoami)", "id")).toThrow(ValidationError);
    expect(() => validateBranchSafeId("id`whoami`", "id")).toThrow(ValidationError);
  });

  it("should reject empty and non-string values", () => {
    expect(() => validateBranchSafeId("", "id")).toThrow(ValidationError);
    expect(() => validateBranchSafeId(null, "id")).toThrow(ValidationError);
    expect(() => validateBranchSafeId(123, "id")).toThrow(ValidationError);
  });

  it("should reject overly long IDs", () => {
    const longId = "a".repeat(101);
    expect(() => validateBranchSafeId(longId, "id")).toThrow(ValidationError);
  });
});

describe("validateSafeText", () => {
  it("should accept normal text", () => {
    expect(validateSafeText("Add user authentication", "title", 500)).toBe("Add user authentication");
    expect(validateSafeText("Fix bug #123", "title", 500)).toBe("Fix bug #123");
  });

  it("should reject empty strings", () => {
    expect(() => validateSafeText("", "title", 500)).toThrow(ValidationError);
  });

  it("should enforce max length", () => {
    expect(() => validateSafeText("a".repeat(501), "title", 500)).toThrow(ValidationError);
    expect(validateSafeText("a".repeat(500), "title", 500)).toHaveLength(500);
  });

  it("should reject non-string values", () => {
    expect(() => validateSafeText(123, "title", 500)).toThrow(ValidationError);
    expect(() => validateSafeText(null, "title", 500)).toThrow(ValidationError);
  });
});

describe("validateSubtasks", () => {
  const validSubtask = {
    id: "task-1",
    title: "Add auth",
    description: "Implement JWT authentication",
    dependencies: [],
  };

  it("should accept valid subtasks", () => {
    const result = validateSubtasks([validSubtask]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("task-1");
    expect(result[0]!.title).toBe("Add auth");
  });

  it("should accept multiple subtasks with dependencies", () => {
    const result = validateSubtasks([
      validSubtask,
      { id: "task-2", title: "Add tests", description: "Write tests for auth", dependencies: ["task-1"] },
    ]);
    expect(result).toHaveLength(2);
    expect(result[1]!.dependencies).toEqual(["task-1"]);
  });

  it("should reject non-array input", () => {
    expect(() => validateSubtasks("not an array")).toThrow(ValidationError);
    expect(() => validateSubtasks(null)).toThrow(ValidationError);
    expect(() => validateSubtasks({})).toThrow(ValidationError);
  });

  it("should reject empty array", () => {
    expect(() => validateSubtasks([])).toThrow(ValidationError);
  });

  it("should reject too many subtasks", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...validSubtask,
      id: `task-${i}`,
    }));
    expect(() => validateSubtasks(many)).toThrow(ValidationError);
  });

  it("should reject subtasks with dangerous IDs", () => {
    expect(() => validateSubtasks([{ ...validSubtask, id: "id; rm -rf /" }])).toThrow(ValidationError);
  });

  it("should reject subtasks with missing fields", () => {
    expect(() => validateSubtasks([{ id: "1" }])).toThrow(ValidationError);
    expect(() => validateSubtasks([{ id: "1", title: "t" }])).toThrow(ValidationError);
  });
});

describe("validateTechStack", () => {
  it("should accept valid tech stack", () => {
    expect(validateTechStack(["TypeScript", "React"])).toEqual(["TypeScript", "React"]);
  });

  it("should reject empty array", () => {
    expect(() => validateTechStack([])).toThrow(ValidationError);
  });

  it("should reject non-array", () => {
    expect(() => validateTechStack("TypeScript")).toThrow(ValidationError);
  });

  it("should reject items that are not strings", () => {
    expect(() => validateTechStack([123])).toThrow(ValidationError);
    expect(() => validateTechStack([""])).toThrow(ValidationError);
  });

  it("should reject too many items", () => {
    const many = Array.from({ length: 21 }, (_, i) => `tech-${i}`);
    expect(() => validateTechStack(many)).toThrow(ValidationError);
  });
});
