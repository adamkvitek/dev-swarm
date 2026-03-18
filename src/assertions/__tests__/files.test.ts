import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { multiFileExists, fileExists } from "../files.js";

const TEST_DIR = join(tmpdir(), `dev-swarm-files-test-${Date.now()}`);

beforeAll(async () => {
  await mkdir(join(TEST_DIR, "sub"), { recursive: true });
  await writeFile(join(TEST_DIR, "hello.txt"), "hello");
  await writeFile(join(TEST_DIR, "data.json"), "{}");
  await writeFile(join(TEST_DIR, "sub", "nested.ts"), "export {}");
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("fileExists", () => {
  it("should pass when file exists", async () => {
    const result = await fileExists(join(TEST_DIR, "hello.txt"));
    expect(result.passed).toBe(true);
    expect(result.message).toContain("File exists");
  });

  it("should fail when file does not exist", async () => {
    const result = await fileExists(join(TEST_DIR, "nope.txt"));
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not found");
  });
});

describe("multiFileExists", () => {
  it("should find files matching a single glob pattern", async () => {
    const results = await multiFileExists({
      basePath: TEST_DIR,
      patterns: ["*.txt"],
    });
    const patternResult = results.find((r) => r.name.includes("*.txt"));
    expect(patternResult?.passed).toBe(true);
    expect(patternResult?.message).toContain("1 file(s)");
  });

  it("should find files matching multiple patterns", async () => {
    const results = await multiFileExists({
      basePath: TEST_DIR,
      patterns: ["*.txt", "*.json"],
    });
    const passed = results.filter((r) => r.passed);
    expect(passed.length).toBe(2);
  });

  it("should find nested files with ** glob", async () => {
    const results = await multiFileExists({
      basePath: TEST_DIR,
      patterns: ["**/*.ts"],
    });
    const tsResult = results.find((r) => r.name.includes("*.ts"));
    expect(tsResult?.passed).toBe(true);
  });

  it("should fail when pattern matches no files", async () => {
    const results = await multiFileExists({
      basePath: TEST_DIR,
      patterns: ["*.xyz"],
    });
    const xyzResult = results.find((r) => r.name.includes("*.xyz"));
    expect(xyzResult?.passed).toBe(false);
    expect(xyzResult?.message).toContain("No files matched");
  });

  it("should fail when basePath does not exist", async () => {
    const results = await multiFileExists({
      basePath: "/tmp/nonexistent-dir-xyz-123",
      patterns: ["*"],
    });
    expect(results[0].passed).toBe(false);
    expect(results[0].message).toContain("does not exist");
  });

  it("should fail when basePath is a file, not a directory", async () => {
    const results = await multiFileExists({
      basePath: join(TEST_DIR, "hello.txt"),
      patterns: ["*"],
    });
    expect(results[0].passed).toBe(false);
    expect(results[0].message).toContain("not a directory");
  });

  it("should enforce minFiles constraint", async () => {
    const results = await multiFileExists({
      basePath: TEST_DIR,
      patterns: ["*.txt"],
      minFiles: 5,
    });
    const minResult = results.find((r) => r.name.includes("minFiles"));
    expect(minResult?.passed).toBe(false);
    expect(minResult?.message).toContain("at least 5");
  });

  it("should enforce maxFiles constraint", async () => {
    const results = await multiFileExists({
      basePath: TEST_DIR,
      patterns: ["*"],
      maxFiles: 1,
    });
    const maxResult = results.find((r) => r.name.includes("maxFiles"));
    expect(maxResult?.passed).toBe(false);
    expect(maxResult?.message).toContain("at most 1");
  });

  it("should pass when file count is within bounds", async () => {
    const results = await multiFileExists({
      basePath: TEST_DIR,
      patterns: ["*.txt", "*.json"],
      minFiles: 1,
      maxFiles: 10,
    });
    const boundsResults = results.filter(
      (r) => r.name.includes("minFiles") || r.name.includes("maxFiles")
    );
    expect(boundsResults).toHaveLength(0); // no bound violation results
  });
});
