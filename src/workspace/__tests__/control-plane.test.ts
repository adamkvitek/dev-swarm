import { describe, it, expect } from "vitest";
import { validateChangedFiles } from "../control-plane.js";

describe("validateChangedFiles", () => {
  describe("should flag control plane files", () => {
    it("should block adapter files", () => {
      const result = validateChangedFiles(["src/adapter/discord-adapter.ts"]);
      expect(result.safe).toBe(false);
      expect(result.controlPlaneFiles).toContain("src/adapter/discord-adapter.ts");
    });

    it("should block config files", () => {
      const result = validateChangedFiles(["src/config/env.ts"]);
      expect(result.safe).toBe(false);
      expect(result.controlPlaneFiles).toContain("src/config/env.ts");
    });

    it("should block workspace files", () => {
      const result = validateChangedFiles(["src/workspace/worktree-manager.ts"]);
      expect(result.safe).toBe(false);
    });

    it("should block MCP files", () => {
      const result = validateChangedFiles(["src/mcp/server.ts"]);
      expect(result.safe).toBe(false);
    });

    it("should block agent files", () => {
      const result = validateChangedFiles(["src/agents/worker.ts"]);
      expect(result.safe).toBe(false);
    });

    it("should block index.ts", () => {
      const result = validateChangedFiles(["src/index.ts"]);
      expect(result.safe).toBe(false);
    });

    it("should block package.json", () => {
      const result = validateChangedFiles(["package.json"]);
      expect(result.safe).toBe(false);
    });

    it("should block tsconfig.json", () => {
      const result = validateChangedFiles(["tsconfig.json"]);
      expect(result.safe).toBe(false);
    });
  });

  describe("should identify NEVER_MODIFY files with stronger warning", () => {
    it("should flag .claude/ files as never-modify", () => {
      const result = validateChangedFiles([".claude/settings.json"]);
      expect(result.safe).toBe(false);
      expect(result.neverModifyFiles).toContain(".claude/settings.json");
      expect(result.reason).toContain("BLOCKED");
    });

    it("should flag .env as never-modify", () => {
      const result = validateChangedFiles([".env"]);
      expect(result.safe).toBe(false);
      expect(result.neverModifyFiles).toContain(".env");
    });

    it("should flag CODEOWNERS as never-modify", () => {
      const result = validateChangedFiles(["CODEOWNERS"]);
      expect(result.safe).toBe(false);
      expect(result.neverModifyFiles).toContain("CODEOWNERS");
    });

    it("should flag .github/workflows as never-modify", () => {
      const result = validateChangedFiles([".github/workflows/ci.yml"]);
      expect(result.safe).toBe(false);
      expect(result.neverModifyFiles).toContain(".github/workflows/ci.yml");
    });
  });

  describe("should allow non-control-plane files", () => {
    it("should allow new feature files", () => {
      const result = validateChangedFiles(["src/features/auth/handler.ts"]);
      expect(result.safe).toBe(true);
      expect(result.controlPlaneFiles).toHaveLength(0);
    });

    it("should allow test files", () => {
      const result = validateChangedFiles(["tests/auth.test.ts"]);
      expect(result.safe).toBe(true);
    });

    it("should allow README and docs", () => {
      const result = validateChangedFiles(["README.md", "docs/setup.md"]);
      expect(result.safe).toBe(true);
    });

    it("should allow files in user code directories", () => {
      const result = validateChangedFiles([
        "src/features/user/service.ts",
        "src/features/user/types.ts",
        "src/lib/utils.ts",
      ]);
      expect(result.safe).toBe(true);
    });
  });

  describe("should handle mixed safe and unsafe files", () => {
    it("should flag as unsafe if any control plane file is present", () => {
      const result = validateChangedFiles([
        "src/features/auth.ts",
        "src/adapter/http-api.ts",
        "README.md",
      ]);
      expect(result.safe).toBe(false);
      expect(result.controlPlaneFiles).toContain("src/adapter/http-api.ts");
      expect(result.controlPlaneFiles).not.toContain("src/features/auth.ts");
    });

    it("should report BLOCKED for never-modify even if regular control plane files present", () => {
      const result = validateChangedFiles([
        "src/adapter/http-api.ts",
        ".claude/hooks.json",
      ]);
      expect(result.safe).toBe(false);
      expect(result.neverModifyFiles).toContain(".claude/hooks.json");
      expect(result.reason).toContain("BLOCKED");
    });
  });

  describe("edge cases", () => {
    it("should handle empty file list", () => {
      const result = validateChangedFiles([]);
      expect(result.safe).toBe(true);
    });

    it("should handle files with similar prefixes that are not control plane", () => {
      // "src/adapter-v2/" should NOT match "src/adapter/"
      const result = validateChangedFiles(["src/adapter-v2/new-file.ts"]);
      expect(result.safe).toBe(true);
    });
  });
});
