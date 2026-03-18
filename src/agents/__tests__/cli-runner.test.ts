import { describe, it, expect } from "vitest";
import { runCli } from "../cli-runner.js";

describe("runCli", () => {
  it("should capture stdout from a simple command", async () => {
    const result = await runCli("echo", ["hello world"], { timeoutMs: 5_000 });
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("should capture stderr", async () => {
    const result = await runCli("sh", ["-c", "echo err >&2"], {
      timeoutMs: 5_000,
    });
    expect(result.stderr.trim()).toBe("err");
  });

  it("should capture non-zero exit codes", async () => {
    const result = await runCli("sh", ["-c", "exit 3"], {
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(3);
  });

  it("should send stdin content to the process", async () => {
    const result = await runCli("cat", [], {
      stdin: "piped input",
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe("piped input");
  });

  it("should not hang when no stdin is provided (stdin is closed)", async () => {
    // `cat` with no file args reads from stdin — if stdin isn't closed, it hangs
    const result = await runCli("cat", [], { timeoutMs: 3_000 });
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should reject on timeout", async () => {
    await expect(
      runCli("sleep", ["10"], { timeoutMs: 200 })
    ).rejects.toThrow("timed out");
  });

  it("should reject when command does not exist", async () => {
    await expect(
      runCli("nonexistent-cmd-xyz-123", [], { timeoutMs: 5_000 })
    ).rejects.toThrow("Failed to spawn");
  });

  describe("OpenClaw safety guard", () => {
    // The guard throws synchronously before spawning the process

    it("should block openclaw commands on host", () => {
      expect(() =>
        runCli("openclaw", ["run", "something"])
      ).toThrow("BLOCKED");
    });

    it("should block commands containing openclaw in args", () => {
      expect(() =>
        runCli("sh", ["-c", "openclaw dangerous"], { timeoutMs: 1_000 })
      ).toThrow("BLOCKED");
    });

    it("should block case-insensitive openclaw references", () => {
      expect(() =>
        runCli("OPENCLAW", ["test"], { timeoutMs: 1_000 })
      ).toThrow("BLOCKED");
    });

    it("should allow openclaw when OPENCLAW_VM_CONFIRMED is set", async () => {
      const originalEnv = process.env.OPENCLAW_VM_CONFIRMED;
      try {
        process.env.OPENCLAW_VM_CONFIRMED = "1";
        // Should not throw the BLOCKED error — will fail for other reasons
        // (command doesn't exist) but that's expected
        await expect(
          runCli("openclaw-fake-test", ["run"], { timeoutMs: 1_000 })
        ).rejects.toThrow("Failed to spawn");
      } finally {
        if (originalEnv === undefined) {
          delete process.env.OPENCLAW_VM_CONFIRMED;
        } else {
          process.env.OPENCLAW_VM_CONFIRMED = originalEnv;
        }
      }
    });

    it("should block openclaw when VM flag is not '1'", () => {
      const originalEnv = process.env.OPENCLAW_VM_CONFIRMED;
      try {
        process.env.OPENCLAW_VM_CONFIRMED = "0";
        expect(() =>
          runCli("openclaw", ["test"], { timeoutMs: 1_000 })
        ).toThrow("BLOCKED");
      } finally {
        if (originalEnv === undefined) {
          delete process.env.OPENCLAW_VM_CONFIRMED;
        } else {
          process.env.OPENCLAW_VM_CONFIRMED = originalEnv;
        }
      }
    });
  });

  it("should use cwd option for spawned process", async () => {
    const result = await runCli("pwd", [], {
      cwd: "/tmp",
      timeoutMs: 5_000,
    });
    // macOS resolves /tmp to /private/tmp
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });
});
