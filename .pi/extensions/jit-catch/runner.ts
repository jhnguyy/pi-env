/**
 * Runner — all side-effectful operations for jit-catch.
 *
 * Responsibilities:
 * - Acquire a diff via git (or accept a raw diff string)
 * - Read source file contents to enrich the subagent prompt
 * - Spawn a pi subagent that outputs test content to stdout
 * - Write the catching test file
 * - Run `bun test` and return pass/fail + output
 * - Auto-discard on pass
 *
 * ExecFn is injected for testability (same pattern as tmux/agent-bus).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionDiff, ExtensionRunResult } from "./types";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Absolute path to the extensions directory. */
export const EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");

// ─── Diff acquisition ─────────────────────────────────────────────────────────

/**
 * Capture a diff by running git in `gitCwd`.
 * Returns the raw diff text, or throws a descriptive Error on failure.
 */
export async function captureDiff(
  source: "unstaged" | "staged" | "commit",
  exec: ExecFn,
  gitCwd: string,
  commit?: string,
): Promise<string> {
  let args: string[];

  switch (source) {
    case "unstaged":
      args = ["diff"];
      break;
    case "staged":
      args = ["diff", "--cached"];
      break;
    case "commit":
      if (!commit) throw new Error("diff_source='commit' requires a commit SHA");
      args = ["show", commit];
      break;
  }

  const result = await exec("git", args, { cwd: gitCwd });

  if (result.code !== 0) {
    throw new Error(
      `git ${args[0]} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }

  if (!result.stdout.trim()) {
    throw new Error(
      `git ${args[0]} produced no output — nothing to verify. ` +
      `If changes are outside a git repo, pass the diff directly via the 'diff' parameter.`,
    );
  }

  return result.stdout;
}

// ─── Environment prep ─────────────────────────────────────────────────────────

/**
 * Ensure the extension has __tests__/ and a minimal package.json.
 * Safe to call multiple times — idempotent.
 */
export function prepareEnv(extDir: string, extName: string): void {
  const testsDir = join(extDir, "__tests__");
  mkdirSync(testsDir, { recursive: true });

  const pkgPath = join(extDir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: extName, type: "module", private: true }, null, 2) + "\n",
    );
  }
}

// ─── Source file reading ──────────────────────────────────────────────────────

const MAX_SOURCE_BYTES = 32_000; // cap total injected source content

/**
 * Read source files changed in the diff and return them as a formatted block.
 * Truncates aggressively to keep the subagent prompt manageable.
 */
export function readSourceFiles(changedFiles: string[]): string {
  const parts: string[] = [];
  let totalBytes = 0;

  for (const relPath of changedFiles) {
    // changedFiles are relative to repo root (e.g. `.pi/agent/extensions/tmux/index.ts`).
    // Resolve against home dir — covers the common `~/.pi/agent/extensions/<ext>/` layout.
    const candidates = [
      join(homedir(), relPath),
      join("/", relPath),
    ];

    let content: string | null = null;
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try { content = readFileSync(candidate, "utf-8"); break; } catch { /* skip */ }
      }
    }

    if (content === null) continue;

    const remaining = MAX_SOURCE_BYTES - totalBytes;
    if (remaining <= 0) break;

    const truncated = content.length > remaining
      ? content.slice(0, remaining) + "\n// ... (truncated)"
      : content;

    parts.push(`// FILE: ${relPath}\n${truncated}`);
    totalBytes += truncated.length;
  }

  return parts.join("\n\n---\n\n");
}

// ─── Subagent prompt ──────────────────────────────────────────────────────────

/**
 * Build the prompt for the test-writer subagent.
 * The subagent must output ONLY the TypeScript test file content to stdout.
 */
export function buildTestPrompt(
  ext: ExtensionDiff,
  diffText: string,
  sourceContent: string,
): string {
  const testPath = `~/.pi/agent/extensions/${ext.name}/__tests__/${ext.name}.catching.test.ts`;

  return [
    `You are a test writer for a pi extension. Generate catching tests for the following diff.`,
    ``,
    `Extension: ${ext.name}`,
    `Source files changed (one per line):`,
    ext.changedFiles.map(f => `  ${f}`).join("\n"),
    ``,
    `## Source File Contents`,
    ``,
    sourceContent || "(source files not readable — work from the diff alone)",
    ``,
    `## Unified Diff`,
    ``,
    "```diff",
    diffText.slice(0, 20_000), // cap — full diff can be very long
    "```",
    ``,
    `## Task`,
    ``,
    `1. Identify changed functions/exports from the diff.`,
    `2. Write 2–4 catching tests covering:`,
    `   - Happy path through the change`,
    `   - One boundary or error condition`,
    `   - If exported: one basic integration case`,
    `3. Test style: use bun:test named imports — \`import { describe, it, expect } from 'bun:test'\``,
    `   Check if existing tests in ${testPath.replace(`${ext.name}.catching.test.ts`, "")} use a different style and match it.`,
    `4. Do NOT test unchanged behaviors.`,
    `5. Output ONLY the TypeScript test file content. No explanation, no markdown fences.`,
    `   The content will be written directly to: ${testPath}`,
  ].join("\n");
}

// ─── Test generation ──────────────────────────────────────────────────────────

/**
 * Spawn a pi subagent to generate the catching test content.
 * Returns the raw TypeScript source that should be written to the test file.
 */
export async function generateTestContent(
  prompt: string,
  exec: ExecFn,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await exec(
    "pi",
    [
      "--print",
      "--no-session",
      "--no-skills",
      "--no-extensions",
      "--tools", "",
      prompt,
    ],
    { timeout: 90_000 },
  );

  if (result.code !== 0) {
    throw new Error(
      `Test-writer subagent failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`,
    );
  }

  // Strip markdown fences if the model wrapped the output anyway.
  let content = result.stdout.trim();
  const fenceMatch = content.match(/^```(?:typescript|ts)?\n([\s\S]*?)\n?```$/);
  if (fenceMatch) content = fenceMatch[1].trim();

  return content;
}

// ─── Test execution ───────────────────────────────────────────────────────────

/**
 * Run `bun test` for the catching test file.
 * Returns pass/fail and the combined output.
 */
export async function runCatchingTests(
  extDir: string,
  extName: string,
  exec: ExecFn,
): Promise<{ passed: boolean; output: string }> {
  const testFile = join("__tests__", `${extName}.catching.test.ts`);

  const result = await exec("bun", ["test", testFile], {
    cwd: extDir,
    timeout: 60_000,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return { passed: result.code === 0, output };
}

// ─── High-level orchestrator ──────────────────────────────────────────────────

/**
 * Run the full jit-catch workflow for a single extension:
 *   prepare env → generate tests → write file → run tests → discard on pass.
 */
export async function runForExtension(
  ext: ExtensionDiff,
  diffText: string,
  exec: ExecFn,
  signal: AbortSignal | undefined,
): Promise<ExtensionRunResult> {
  const extDir = join(EXTENSIONS_DIR, ext.name);

  if (!existsSync(extDir)) {
    return {
      extName: ext.name,
      passed: false,
      testOutput: `Extension directory not found: ${extDir}`,
      testPath: null,
    };
  }

  // 1. Prepare environment
  prepareEnv(extDir, ext.name);

  // 2. Read source files for context
  const sourceContent = readSourceFiles(ext.changedFiles);

  // 3. Build prompt and generate tests via subagent
  const prompt = buildTestPrompt(ext, diffText, sourceContent);
  let testContent: string;
  try {
    testContent = await generateTestContent(prompt, exec, signal);
  } catch (e) {
    return {
      extName: ext.name,
      passed: false,
      testOutput: `Test generation failed: ${e}`,
      testPath: null,
    };
  }

  // 4. Write the test file
  const testPath = join(extDir, "__tests__", `${ext.name}.catching.test.ts`);
  writeFileSync(testPath, testContent + "\n");

  // 5. Run tests
  const { passed, output } = await runCatchingTests(extDir, ext.name, exec);

  // 6. Auto-discard on pass
  if (passed) {
    try { unlinkSync(testPath); } catch { /* ignore — file might already be gone */ }
    return { extName: ext.name, passed: true, testOutput: output, testPath: null };
  }

  return { extName: ext.name, passed: false, testOutput: output, testPath };
}
