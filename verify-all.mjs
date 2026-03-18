#!/usr/bin/env node

/**
 * verify-all.mjs — Interactive verification runner for multi-language code samples.
 *
 * Presents a menu to select languages (Python, Java/Maven, C#/.NET),
 * runs code samples in each, and validates outputs using the assertion library.
 *
 * Usage: node verify-all.mjs [--all] [--lang python,java,csharp] [--samples-dir <path>]
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { readdir, readFile, stat, writeFile, unlink, rm } from "node:fs/promises";
import { join, resolve, extname, basename, dirname } from "node:path";
import { spawn, execFileSync } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────────

/** @typedef {"python" | "java" | "csharp"} SupportedLanguage */

/** @typedef {{ language: SupportedLanguage; sampleId: string; stdout: string; stderr: string; exitCode: number; outputFiles: string[] }} LanguageRun */

/** @typedef {{ passed: boolean; name: string; message: string; expected?: string; actual?: string }} AssertionResult */

// ── Constants ──────────────────────────────────────────────────────────────

const LANGUAGES = /** @type {const} */ ({
  python: { name: "Python", ext: ".py", run: ["python3"], compile: null },
  java: { name: "Java/Maven", ext: ".java", run: ["java"], compile: ["javac"] },
  csharp: { name: "C#/.NET", ext: ".cs", run: ["dotnet", "run"], compile: null },
});

/** Default timeout per language (ms). Maven/C# need longer for dependency resolution + build. */
const LANGUAGE_TIMEOUTS = /** @type {Record<SupportedLanguage, number>} */ ({
  python: 30_000,
  java: 120_000,
  csharp: 120_000,
});

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

// ── Prerequisite Checks ─────────────────────────────────────────────────────

/** @type {Record<SupportedLanguage, { commands: string[]; installHint: string }>} */
const PREREQUISITES = {
  python: {
    commands: ["python3"],
    installHint: "Install Python 3: https://www.python.org/downloads/",
  },
  java: {
    commands: ["javac", "java"],
    installHint: "Install JDK: https://adoptium.net/ or brew install openjdk",
  },
  csharp: {
    commands: ["dotnet"],
    installHint: "Install .NET SDK: https://dotnet.microsoft.com/download",
  },
};

/**
 * Check if a command is available on $PATH.
 * @param {string} cmd
 * @returns {boolean}
 */
function isCommandAvailable(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that required runtime commands exist for the selected languages.
 *
 * @param {SupportedLanguage[]} languages
 * @returns {{ available: SupportedLanguage[]; missing: Array<{ language: SupportedLanguage; commands: string[]; hint: string }> }}
 */
function checkPrerequisites(languages) {
  /** @type {SupportedLanguage[]} */
  const available = [];
  /** @type {Array<{ language: SupportedLanguage; commands: string[]; hint: string }>} */
  const missing = [];

  for (const lang of languages) {
    const prereq = PREREQUISITES[lang];
    const missingCmds = prereq.commands.filter((cmd) => !isCommandAvailable(cmd));

    if (missingCmds.length > 0) {
      missing.push({ language: lang, commands: missingCmds, hint: prereq.installHint });
    } else {
      available.push(lang);
    }
  }

  return { available, missing };
}

// ── CLI Argument Parsing ───────────────────────────────────────────────────

function parseArgs() {
  const args = argv.slice(2);
  const options = {
    all: false,
    languages: /** @type {SupportedLanguage[]} */ ([]),
    samplesDir: resolve("samples"),
    patterns: /** @type {string[]} */ ([]),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--all":
        options.all = true;
        break;
      case "--lang":
        options.languages = /** @type {SupportedLanguage[]} */ (
          (args[++i] ?? "").split(",").filter(Boolean)
        );
        break;
      case "--samples-dir":
        options.samplesDir = resolve(args[++i] ?? "samples");
        break;
      case "--pattern":
        options.patterns.push(args[++i] ?? "");
        break;
      case "--help":
        printHelp();
        exit(0);
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
${COLORS.bold}verify-all.mjs${COLORS.reset} — Multi-language code sample verification

${COLORS.bold}Usage:${COLORS.reset}
  node verify-all.mjs                      Interactive mode
  node verify-all.mjs --all                Run all languages
  node verify-all.mjs --lang python,java   Run specific languages
  node verify-all.mjs --samples-dir <dir>  Set samples directory
  node verify-all.mjs --pattern "*.py"     Filter samples by pattern

${COLORS.bold}Supported languages:${COLORS.reset}
  python   Python 3 (.py files)
  java     Java/Maven (.java files — auto-detects pom.xml for Maven, falls back to javac)
  csharp   C#/.NET (.cs files, run with dotnet run + NuGet restore)
`);
}

// ── Interactive Menu ───────────────────────────────────────────────────────

/**
 * Show interactive language selection menu.
 * @returns {Promise<SupportedLanguage[]>}
 */
async function showLanguageMenu() {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log(`\n${COLORS.bold}Select languages to verify:${COLORS.reset}\n`);
  console.log("  1) Python");
  console.log("  2) Java/Maven");
  console.log("  3) C#/.NET");
  console.log("  4) All languages");
  console.log("  0) Exit\n");

  const answer = await rl.question(`${COLORS.cyan}Choose (comma-separated, e.g. 1,2): ${COLORS.reset}`);
  rl.close();

  const choices = answer.split(",").map((s) => s.trim());
  /** @type {SupportedLanguage[]} */
  const selected = [];

  for (const choice of choices) {
    switch (choice) {
      case "1":
        if (!selected.includes("python")) selected.push("python");
        break;
      case "2":
        if (!selected.includes("java")) selected.push("java");
        break;
      case "3":
        if (!selected.includes("csharp")) selected.push("csharp");
        break;
      case "4":
        return ["python", "java", "csharp"];
      case "0":
        exit(0);
        break;
      default:
        if (choice in LANGUAGES && !selected.includes(/** @type {SupportedLanguage} */ (choice))) {
          selected.push(/** @type {SupportedLanguage} */ (choice));
        }
    }
  }

  if (selected.length === 0) {
    console.log(`${COLORS.yellow}No languages selected. Exiting.${COLORS.reset}`);
    exit(0);
  }

  return selected;
}

// ── Sample Discovery ───────────────────────────────────────────────────────

/**
 * @param {string} samplesDir
 * @param {SupportedLanguage[]} languages
 * @returns {Promise<Map<string, Map<SupportedLanguage, string>>>}
 */
async function discoverSamples(samplesDir, languages) {
  /** @type {Map<string, Map<SupportedLanguage, string>>} */
  const samples = new Map();

  try {
    await stat(samplesDir);
  } catch {
    console.log(`${COLORS.yellow}Samples directory not found: ${samplesDir}${COLORS.reset}`);
    console.log(`Create it with subdirectories per sample, e.g.:`);
    console.log(`  ${samplesDir}/hello-world/hello.py`);
    console.log(`  ${samplesDir}/hello-world/Hello.java`);
    console.log(`  ${samplesDir}/hello-world/Hello.cs`);
    return samples;
  }

  const entries = await readdir(samplesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sampleId = entry.name;
    const sampleDir = join(samplesDir, sampleId);
    const files = await readdir(sampleDir);

    /** @type {Map<SupportedLanguage, string>} */
    const langFiles = new Map();

    for (const file of files) {
      const ext = extname(file);
      for (const [lang, config] of Object.entries(LANGUAGES)) {
        if (ext === config.ext && languages.includes(/** @type {SupportedLanguage} */ (lang))) {
          langFiles.set(/** @type {SupportedLanguage} */ (lang), join(sampleDir, file));
        }
      }
    }

    if (langFiles.size > 0) {
      samples.set(sampleId, langFiles);
    }
  }

  return samples;
}

// ── C# Project Helpers ────────────────────────────────────────────────────

/** @param {string} dir */
async function findCsproj(dir) {
  try {
    const files = await readdir(dir);
    const csproj = files.find((f) => f.endsWith(".csproj"));
    return csproj ? join(dir, csproj) : null;
  } catch {
    return null;
  }
}

/** @param {string} csFilePath */
async function scaffoldCsproj(csFilePath) {
  const dir = dirname(csFilePath);
  const name = basename(csFilePath, ".cs");
  const csprojPath = join(dir, `${name}.csproj`);

  const csprojContent = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`;

  await writeFile(csprojPath, csprojContent, "utf-8");
  return csprojPath;
}

function parseDotnetBuildOutput(buildOutput) {
  const lines = buildOutput.split("\n");
  const errors = lines.filter((l) => /\berror\b\s*(CS|MSB|NU)\d+/i.test(l));
  const warnings = lines.filter((l) => /\bwarning\b\s*(CS|MSB|NU)\d+/i.test(l));
  return { errors, warnings };
}

// ── Java/Maven Helpers ─────────────────────────────────────────────────────

/**
 * Check if a pom.xml exists in the given directory (Maven project detection).
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function detectMavenProject(dir) {
  try {
    await stat(join(dir, "pom.xml"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the fully-qualified main class name for a Java file.
 * Checks pom.xml for exec-maven-plugin <mainClass> config first,
 * then parses the Java source for package declaration.
 *
 * @param {string} filePath
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function detectMainClass(filePath, cwd) {
  try {
    const pomContent = await readFile(join(cwd, "pom.xml"), "utf8");
    const match = pomContent.match(/<mainClass>([\w.]+)<\/mainClass>/);
    if (match) return match[1];
  } catch {
    // fall through
  }

  try {
    const content = await readFile(filePath, "utf8");
    const packageMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    const packageName = packageMatch ? packageMatch[1] : "";
    const className = basename(filePath, ".java");
    return packageName ? `${packageName}.${className}` : className;
  } catch {
    return basename(filePath, ".java");
  }
}

/**
 * Strip Maven build noise from stdout/stderr.
 * @param {string} rawStdout
 * @param {string} rawStderr
 * @returns {{ stdout: string; stderr: string }}
 */
function parseMavenOutput(rawStdout, rawStderr) {
  const cleanStdout = rawStdout
    .split("\n")
    .filter((line) => !/^\[(?:INFO|WARNING)\]\s/.test(line))
    .join("\n");

  const cleanStderr = rawStderr
    .split("\n")
    .filter((line) => !/^\[INFO\]\s/.test(line))
    .map((line) => line.replace(/^\[(?:ERROR|WARNING)\]\s*/, ""))
    .join("\n")
    .trim();

  return { stdout: cleanStdout, stderr: cleanStderr };
}

/**
 * Clean up Java build artifacts after execution.
 * @param {string} cwd
 * @param {{ isMaven: boolean; className?: string }} options
 */
async function cleanupJavaArtifacts(cwd, options) {
  if (options.isMaven) {
    await rm(join(cwd, "target"), { recursive: true, force: true }).catch(() => {});
  }
  if (options.className) {
    await unlink(join(cwd, `${options.className}.class`)).catch(() => {});
    try {
      const files = await readdir(cwd);
      for (const file of files) {
        if (file.startsWith(`${options.className}$`) && file.endsWith(".class")) {
          await unlink(join(cwd, file)).catch(() => {});
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

// ── Code Execution ─────────────────────────────────────────────────────────

async function executeCsharp(filePath, cwd, timeoutMs) {
  let scaffoldedCsproj = null;

  try {
    const existingCsproj = await findCsproj(cwd);
    if (!existingCsproj) {
      scaffoldedCsproj = await scaffoldCsproj(filePath);
    }

    const restoreResult = await spawnWithTimeout(
      "dotnet", ["restore", "--verbosity", "quiet"],
      { cwd, timeoutMs: Math.min(timeoutMs, 60_000) }
    );
    if (restoreResult.exitCode !== 0) {
      const { errors } = parseDotnetBuildOutput(restoreResult.stderr + restoreResult.stdout);
      return {
        stdout: "",
        stderr: `NuGet restore failed:\n${errors.length > 0 ? errors.join("\n") : restoreResult.stderr.slice(0, 500)}`,
        exitCode: restoreResult.exitCode,
      };
    }

    const buildResult = await spawnWithTimeout(
      "dotnet", ["build", "--verbosity", "quiet", "--no-restore"],
      { cwd, timeoutMs: Math.min(timeoutMs, 60_000) }
    );
    if (buildResult.exitCode !== 0) {
      const { errors } = parseDotnetBuildOutput(buildResult.stderr + buildResult.stdout);
      return {
        stdout: "",
        stderr: `Build failed:\n${errors.length > 0 ? errors.join("\n") : buildResult.stderr.slice(0, 500)}`,
        exitCode: buildResult.exitCode,
      };
    }

    return await spawnWithTimeout("dotnet", ["run", "--no-build"], { cwd, timeoutMs });
  } finally {
    if (scaffoldedCsproj) {
      await unlink(scaffoldedCsproj).catch(() => {});
    }
  }
}

/**
 * Execute a Java sample. Auto-detects Maven (pom.xml) vs plain javac.
 */
async function executeJava(filePath, cwd, timeoutMs) {
  const isMaven = await detectMavenProject(cwd);

  if (isMaven && isCommandAvailable("mvn")) {
    return executeMavenJava(filePath, cwd, timeoutMs);
  }

  if (isMaven && !isCommandAvailable("mvn")) {
    console.log(`        ${COLORS.yellow}pom.xml found but mvn not on PATH — falling back to javac${COLORS.reset}`);
  }

  const className = basename(filePath, ".java");
  return executeJavacJava(filePath, cwd, timeoutMs, className);
}

/**
 * Execute a Java sample via Maven: mvn -q compile exec:java.
 * Cleans up target/ directory after execution.
 */
async function executeMavenJava(filePath, cwd, timeoutMs) {
  const mainClass = await detectMainClass(filePath, cwd);

  try {
    const result = await spawnWithTimeout(
      "mvn",
      ["-q", "compile", "exec:java", `-Dexec.mainClass=${mainClass}`],
      { cwd, timeoutMs }
    );

    const parsed = parseMavenOutput(result.stdout, result.stderr);
    return { stdout: parsed.stdout, stderr: parsed.stderr, exitCode: result.exitCode };
  } finally {
    await cleanupJavaArtifacts(cwd, { isMaven: true });
  }
}

/**
 * Execute a Java file via javac -> java (no Maven).
 * Cleans up .class files after execution.
 */
async function executeJavacJava(filePath, cwd, timeoutMs, className) {
  try {
    const compileResult = await spawnWithTimeout(
      "javac", [filePath], { cwd, timeoutMs: Math.min(timeoutMs, 60_000) }
    );
    if (compileResult.exitCode !== 0) {
      return {
        stdout: "",
        stderr: `Compilation failed:\n${compileResult.stderr}`,
        exitCode: compileResult.exitCode,
      };
    }

    return await spawnWithTimeout(
      "java", ["-cp", cwd, className], { cwd, timeoutMs }
    );
  } finally {
    await cleanupJavaArtifacts(cwd, { isMaven: false, className });
  }
}

/**
 * Execute a code file and capture output.
 * Delegates to language-specific runners for Java and C#.
 */
async function executeFile(language, filePath, cwd) {
  const config = LANGUAGES[language];
  const timeoutMs = LANGUAGE_TIMEOUTS[language] ?? 30_000;

  if (language === "csharp") {
    return executeCsharp(filePath, cwd, timeoutMs);
  }

  if (language === "java") {
    return executeJava(filePath, cwd, timeoutMs);
  }

  // Python: direct execution
  return spawnWithTimeout(config.run[0], [filePath], { cwd, timeoutMs });
}

/**
 * Spawn a process with timeout.
 * Always closes stdin immediately to prevent child process hangs.
 * Suppresses EPIPE errors on stdin if the process exits before stdin closes.
 * Uses SIGKILL fallback if SIGTERM doesn't terminate the process tree.
 */
function spawnWithTimeout(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let killed = false;

    proc.stdout.on("data", (data) => {
      stdoutBuf += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderrBuf += data.toString();
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      // Force kill after 5s if SIGTERM doesn't work (e.g., Maven child processes)
      const forceTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
      forceTimer.unref();
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`Timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
      } else {
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code ?? 1 });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    // Suppress EPIPE if process exits before stdin is fully closed
    proc.stdin.on("error", () => {});
    proc.stdin.end();
  });
}

// ── Inline Assertions (no TS imports needed) ───────────────────────────────

function stdoutContains(capturedStdout, pattern, options = {}) {
  const { mode = "string", ignoreCase = false, invertMatch = false } = options;
  const label = pattern.length > 60 ? pattern.slice(0, 57) + "..." : pattern;
  const name = `stdoutContains(${invertMatch ? "NOT " : ""}"${label}")`;

  if (!pattern) {
    return { passed: false, name, message: "Pattern must be non-empty" };
  }

  let found = false;
  let detail = "";

  if (mode === "regex") {
    try {
      const re = new RegExp(pattern, ignoreCase ? "i" : "");
      const m = re.exec(capturedStdout);
      found = m !== null;
      detail = found ? `Matched at index ${m.index}` : "No regex match";
    } catch (err) {
      return { passed: false, name, message: `Invalid regex: ${err.message}` };
    }
  } else {
    const hay = ignoreCase ? capturedStdout.toLowerCase() : capturedStdout;
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    const idx = hay.indexOf(needle);
    found = idx !== -1;
    detail = found ? `Found at index ${idx}` : "Not found";
  }

  const passed = invertMatch ? !found : found;
  return {
    passed,
    name,
    message: passed
      ? invertMatch ? "Correctly absent" : detail
      : invertMatch ? `Unexpectedly present. ${detail}` : detail,
  };
}

function validateCrossLanguage(runs) {
  /** @type {AssertionResult[]} */
  const results = [];
  const inconsistencies = [];

  /** @type {Map<string, LanguageRun[]>} */
  const bySample = new Map();
  for (const run of runs) {
    const existing = bySample.get(run.sampleId) ?? [];
    existing.push(run);
    bySample.set(run.sampleId, existing);
  }

  for (const [sampleId, sampleRuns] of bySample) {
    if (sampleRuns.length < 2) {
      results.push({
        passed: true,
        name: `crossLang("${sampleId}")`,
        message: `Only ${sampleRuns.length} run(s) — skipping comparison`,
      });
      continue;
    }

    const exitCodes = sampleRuns.map((r) => r.exitCode);
    const uniqueExits = new Set(exitCodes);
    if (uniqueExits.size > 1) {
      inconsistencies.push({ field: "exitCode", sampleId });
      const detail = sampleRuns.map((r) => `${r.language}=${r.exitCode}`).join(", ");
      results.push({ passed: false, name: `crossLang("${sampleId}").exitCode`, message: `Exit codes differ: ${detail}` });
    } else {
      results.push({ passed: true, name: `crossLang("${sampleId}").exitCode`, message: `All exited with code ${[...uniqueExits][0]}` });
    }

    const normalized = sampleRuns.map((r) => ({
      lang: r.language,
      output: r.stdout.replace(/\r\n/g, "\n").replace(/\n+$/, "").trim(),
    }));
    const uniqueOutputs = new Set(normalized.map((n) => n.output));
    if (uniqueOutputs.size > 1) {
      inconsistencies.push({ field: "stdout", sampleId });
      const langs = normalized.map((n) => n.lang).join(", ");
      results.push({ passed: false, name: `crossLang("${sampleId}").stdout`, message: `Stdout differs across ${langs}` });
    } else {
      results.push({ passed: true, name: `crossLang("${sampleId}").stdout`, message: `All ${sampleRuns.length} runs produced identical output` });
    }
  }

  return { consistent: inconsistencies.length === 0, results, inconsistencies };
}

// ── Output Formatting ──────────────────────────────────────────────────────

function formatResult(result) {
  const icon = result.passed ? `${COLORS.green}PASS${COLORS.reset}` : `${COLORS.red}FAIL${COLORS.reset}`;
  return `  ${icon}  ${result.name}\n        ${COLORS.dim}${result.message}${COLORS.reset}`;
}

function printSummary(results) {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`\n${COLORS.bold}Summary:${COLORS.reset}`);
  console.log(`  Total:  ${total}`);
  console.log(`  ${COLORS.green}Passed: ${passed}${COLORS.reset}`);
  if (failed > 0) {
    console.log(`  ${COLORS.red}Failed: ${failed}${COLORS.reset}`);
  }
  console.log();
}

// ── Expectations Loading ──────────────────────────────────────────────────

/**
 * @typedef {{
 *   skip?: boolean;
 *   skipReason?: string;
 *   assertions?: Array<{ pattern: string; mode?: "string" | "regex"; ignoreCase?: boolean; invertMatch?: boolean }>;
 *   expectedExitCode?: number;
 * }} SampleExpectation
 */

/** @typedef {Record<string, Record<string, SampleExpectation>>} ExpectationsFile */

async function loadExpectations() {
  try {
    const raw = await readFile(resolve("sample-expectations.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getExpectation(expectations, sampleId, language) {
  return expectations?.[sampleId]?.[language] ?? expectations?.[sampleId]?.["*"] ?? null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  console.log(`${COLORS.bold}verify-all.mjs${COLORS.reset} — Multi-language verification runner\n`);

  /** @type {SupportedLanguage[]} */
  let languages;
  if (options.all) {
    languages = ["python", "java", "csharp"];
  } else if (options.languages.length > 0) {
    languages = options.languages;
  } else {
    languages = await showLanguageMenu();
  }

  const { available, missing } = checkPrerequisites(languages);

  if (missing.length > 0) {
    console.log(`${COLORS.yellow}Missing runtime prerequisites:${COLORS.reset}`);
    for (const m of missing) {
      console.log(`  ${COLORS.red}${LANGUAGES[m.language].name}${COLORS.reset}: missing ${m.commands.join(", ")}`);
      console.log(`    ${COLORS.dim}${m.hint}${COLORS.reset}`);
    }
    console.log();

    if (available.length === 0) {
      console.log(`${COLORS.red}No selected languages have their runtimes installed. Exiting.${COLORS.reset}`);
      exit(1);
    }

    console.log(`${COLORS.yellow}Continuing with available languages only.${COLORS.reset}\n`);
    languages = available;
  }

  console.log(`\n${COLORS.bold}Languages:${COLORS.reset} ${languages.map((l) => LANGUAGES[l].name).join(", ")}`);
  console.log(`${COLORS.bold}Samples dir:${COLORS.reset} ${options.samplesDir}\n`);

  const expectations = await loadExpectations();
  const hasExpectations = Object.keys(expectations).length > 0;
  if (hasExpectations) {
    console.log(`${COLORS.dim}Loaded sample-expectations.json (${Object.keys(expectations).length} sample(s))${COLORS.reset}\n`);
  }

  const samples = await discoverSamples(options.samplesDir, languages);

  if (samples.size === 0) {
    console.log(`${COLORS.yellow}No samples found.${COLORS.reset}`);
    console.log(`\nExpected directory structure:`);
    console.log(`  ${options.samplesDir}/`);
    console.log(`    hello-world/`);
    console.log(`      hello.py`);
    console.log(`      Hello.java`);
    console.log(`      Hello.cs`);
    exit(1);
  }

  console.log(`Found ${samples.size} sample(s):\n`);

  /** @type {LanguageRun[]} */
  const allRuns = [];
  /** @type {AssertionResult[]} */
  const allResults = [];
  let skipped = 0;

  for (const [sampleId, langFiles] of samples) {
    console.log(`${COLORS.bold}--- ${sampleId} ---${COLORS.reset}`);
    console.log(`  Languages: ${[...langFiles.keys()].join(", ")}\n`);

    for (const [lang, filePath] of langFiles) {
      const cwd = join(options.samplesDir, sampleId);
      const expectation = getExpectation(expectations, sampleId, lang);

      if (expectation?.skip) {
        skipped++;
        allResults.push({
          passed: true,
          name: `${sampleId}/${lang}.skip`,
          message: `Skipped: ${expectation.skipReason ?? "no reason given"}`,
        });
        console.log(`  ${COLORS.yellow}SKIP${COLORS.reset}  ${sampleId}/${lang}`);
        console.log(`        ${COLORS.dim}${expectation.skipReason ?? "no reason"}${COLORS.reset}\n`);
        continue;
      }

      console.log(`  ${COLORS.cyan}Running ${LANGUAGES[lang].name}...${COLORS.reset}`);

      try {
        const result = await executeFile(lang, filePath, cwd);
        allRuns.push({
          language: lang, sampleId,
          stdout: result.stdout, stderr: result.stderr,
          exitCode: result.exitCode, outputFiles: [],
        });

        const expectedExit = expectation?.expectedExitCode ?? 0;
        const exitResult = {
          passed: result.exitCode === expectedExit,
          name: `${sampleId}/${lang}.exitCode`,
          message: result.exitCode === expectedExit
            ? `Exited with expected code ${expectedExit}`
            : `Expected exit ${expectedExit}, got ${result.exitCode}\n        stderr: ${result.stderr.slice(0, 200)}`,
        };
        allResults.push(exitResult);
        console.log(formatResult(exitResult));

        const hasOutput = stdoutContains(result.stdout, "\\S", { mode: "regex" });
        hasOutput.name = `${sampleId}/${lang}.hasOutput`;
        allResults.push(hasOutput);
        console.log(formatResult(hasOutput));

        if (expectation?.assertions) {
          for (const assertion of expectation.assertions) {
            const label = assertion.pattern.length > 40
              ? assertion.pattern.slice(0, 37) + "..."
              : assertion.pattern;
            const custom = stdoutContains(result.stdout, assertion.pattern, {
              mode: assertion.mode ?? "string",
              ignoreCase: assertion.ignoreCase ?? false,
              invertMatch: assertion.invertMatch ?? false,
            });
            custom.name = `${sampleId}/${lang}.assert("${label}")`;
            allResults.push(custom);
            console.log(formatResult(custom));
          }
        }

        if (result.stdout.trim()) {
          const preview = result.stdout.trim().split("\n").slice(0, 3).join("\n        ");
          console.log(`        ${COLORS.dim}stdout: ${preview}${COLORS.reset}`);
        }
      } catch (err) {
        allResults.push({
          passed: false,
          name: `${sampleId}/${lang}.execution`,
          message: `Execution error: ${err.message}`,
        });
        console.log(formatResult(allResults[allResults.length - 1]));
      }

      console.log();
    }
  }

  if (allRuns.length >= 2) {
    console.log(`${COLORS.bold}--- Cross-Language Validation ---${COLORS.reset}\n`);
    const crossResult = validateCrossLanguage(allRuns);

    for (const result of crossResult.results) {
      allResults.push(result);
      console.log(formatResult(result));
    }

    if (!crossResult.consistent) {
      console.log(`\n  ${COLORS.yellow}Inconsistencies detected:${COLORS.reset}`);
      for (const inc of crossResult.inconsistencies) {
        console.log(`    - ${inc.sampleId}: ${inc.field} differs`);
      }
    }
  }

  printSummary(allResults);
  if (skipped > 0) {
    console.log(`  ${COLORS.yellow}Skipped: ${skipped}${COLORS.reset}\n`);
  }

  const failed = allResults.filter((r) => !r.passed).length;
  exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${COLORS.red}Fatal: ${err.message}${COLORS.reset}`);
  exit(1);
});
