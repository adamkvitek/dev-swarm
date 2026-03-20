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

  it("should use cwd option for spawned process", async () => {
    const result = await runCli("pwd", [], {
      cwd: "/tmp",
      timeoutMs: 5_000,
    });
    // macOS resolves /tmp to /private/tmp
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });
});
