/**
 * Runner — all side-effectful operations for jit-catch.
 *
 * Responsibilities:
 * - Acquire a diff via git (or accept a raw diff string)
 * - Read source file contents to enrich the subagent prompt
 * - Spawn a pi subagent that outputs test content to stdout
 * - Write the catching test file
 * - Run `npm test` and return pass/fail + output
 * - Auto-discard on pass
 *
 * ExecFn is injected for testability (same pattern as jit-catch).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";
import type { ExtensionDiff, ExtensionRunResult } from "./types";

export type ExecResult = { code: number; stdout: string; stderr: string };

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

export class ExecPhaseError extends Data.TaggedError("ExecPhaseError")<{
  readonly phase: string;
  readonly command: string;
  readonly cause: unknown;
}> {}

export class FsPhaseError extends Data.TaggedError("FsPhaseError")<{
  readonly phase: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export class UserPhaseError extends Data.TaggedError("UserPhaseError")<{
  readonly phase: string;
  readonly message: string;
}> {}

export type JitCatchPhaseError = ExecPhaseError | FsPhaseError;
export type JitCatchUserFacingError = UserPhaseError | JitCatchPhaseError;

function execEffect(
  phase: string,
  exec: ExecFn,
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Effect.Effect<ExecResult, ExecPhaseError> {
  return Effect.tryPromise({
    try: (signal) => exec(cmd, args, { ...opts, signal }),
    catch: (cause) => new ExecPhaseError({ phase, command: [cmd, ...args].join(" "), cause }),
  });
}

function fsEffect<A>(phase: string, path: string, run: () => A): Effect.Effect<A, FsPhaseError> {
  return Effect.try({
    try: run,
    catch: (cause) => new FsPhaseError({ phase, path, cause }),
  });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function phaseErrorMessage(error: JitCatchPhaseError): string {
  if (error._tag === "ExecPhaseError") {
    return `Operational subprocess failure during ${error.phase}: ${error.command}: ${causeMessage(error.cause)}`;
  }
  return `Operational filesystem failure during ${error.phase}: ${error.path}: ${causeMessage(error.cause)}`;
}

export function formatRunnerError(error: JitCatchUserFacingError): string {
  return error._tag === "UserPhaseError" ? error.message : phaseErrorMessage(error);
}

export function phaseErrorToRunResult(
  ext: ExtensionDiff,
  error: JitCatchPhaseError,
  workspaceRoot: string,
): ExtensionRunResult {
  const diagnosticPath = join(
    resolveExtensionDir(ext, workspaceRoot),
    "__tests__",
    `${ext.name}.catching.test.ts`,
  );

  return {
    extName: ext.name,
    passed: false,
    testOutput: phaseErrorMessage(error),
    testPath: existsSync(diagnosticPath) ? diagnosticPath : null,
  };
}

function generationErrorMessage(error: UserPhaseError | ExecPhaseError): string {
  return formatRunnerError(error);
}

/** Absolute path to the extensions directory. */
export const EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");

/**
 * Resolve the git repository root for project-local extension diffs.
 * Falls back to gitCwd so raw/non-git callers still get deterministic paths.
 */
export function resolveGitRootEffect(exec: ExecFn, gitCwd: string): Effect.Effect<string, ExecPhaseError> {
  return Effect.map(
    execEffect("resolve git root", exec, "git", ["rev-parse", "--show-toplevel"], { cwd: gitCwd }),
    (result) => result.code === 0 && result.stdout.trim() ? result.stdout.trim() : gitCwd,
  );
}

export async function resolveGitRoot(exec: ExecFn, gitCwd: string): Promise<string> {
  return await Effect.runPromise(resolveGitRootEffect(exec, gitCwd));
}

/**
 * Resolve an extension directory from parsed diff paths.
 *
 * jit-catch originally assumed installed global extensions live under
 * ~/.pi/agent/extensions/<name>. pi-env usually edits project-local extensions
 * under .pi/extensions/<name> in a worktree, so derive the directory from the
 * changed file path relative to the git root first, then fall back to the legacy
 * global location for older/global-extension workflows.
 */
export function resolveExtensionDir(ext: ExtensionDiff, workspaceRoot: string): string {
  const marker = `extensions/${ext.name}/`;
  const changedFile = ext.changedFiles.find((file) => file.includes(marker));
  if (changedFile) {
    const markerEnd = changedFile.indexOf(marker) + marker.length;
    const relativeExtDir = changedFile.slice(0, markerEnd - 1);
    const projectLocal = join(workspaceRoot, relativeExtDir);
    if (existsSync(projectLocal)) return projectLocal;
  }

  return join(EXTENSIONS_DIR, ext.name);
}

// ─── Diff acquisition ─────────────────────────────────────────────────────────

/**
 * Capture a diff by running git in `gitCwd`.
 * Returns the raw diff text, or throws a descriptive Error on failure.
 */
export function captureDiffEffect(
  source: "unstaged" | "staged" | "commit",
  exec: ExecFn,
  gitCwd: string,
  commit?: string,
): Effect.Effect<string, UserPhaseError | ExecPhaseError> {
  let args: string[];

  switch (source) {
    case "unstaged":
      args = ["diff"];
      break;
    case "staged":
      args = ["diff", "--cached"];
      break;
    case "commit":
      if (!commit) {
        return Effect.fail(new UserPhaseError({
          phase: "capture diff",
          message: "diff_source='commit' requires a commit SHA",
        }));
      }
      args = ["show", commit];
      break;
  }

  return Effect.flatMap(
    execEffect("capture diff", exec, "git", args, { cwd: gitCwd }),
    (result) => {
      if (result.code !== 0) {
        return Effect.fail(new UserPhaseError({
          phase: "capture diff",
          message: `git ${args[0]} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
        }));
      }

      if (!result.stdout.trim()) {
        return Effect.fail(new UserPhaseError({
          phase: "capture diff",
          message: `git ${args[0]} produced no output — nothing to verify. ` +
            `If changes are outside a git repo, pass the diff directly via the 'diff' parameter.`,
        }));
      }

      return Effect.succeed(result.stdout);
    },
  );
}

export async function captureDiff(
  source: "unstaged" | "staged" | "commit",
  exec: ExecFn,
  gitCwd: string,
  commit?: string,
): Promise<string> {
  return await Effect.runPromise(captureDiffEffect(source, exec, gitCwd, commit));
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
export function readSourceFiles(changedFiles: string[], workspaceRoot: string): string {
  const parts: string[] = [];
  let totalBytes = 0;

  for (const relPath of changedFiles) {
    // changedFiles are relative to repo root for git diffs. Resolve against the
    // current workspace first (project-local extensions), then legacy/global paths.
    const candidates = [
      join(workspaceRoot, relPath),
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
  extDir: string,
): string {
  const testPath = join(extDir, "__tests__", `${ext.name}.catching.test.ts`);

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
    `3. Test style: use Vitest named imports — \`import { describe, it, expect } from 'vitest'\``,
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
export function generateTestContentEffect(
  prompt: string,
  exec: ExecFn,
): Effect.Effect<string, UserPhaseError | ExecPhaseError> {
  return Effect.flatMap(
    execEffect("generate tests", exec, "pi", [
      "--print",
      "--no-session",
      "--no-skills",
      "--no-extensions",
      "--tools", "",
      prompt,
    ], { timeout: 90_000 }),
    (result) => {
      if (result.code !== 0) {
        return Effect.fail(new UserPhaseError({
          phase: "generate tests",
          message: `Test-writer subagent failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`,
        }));
      }

      // Strip markdown fences if the model wrapped the output anyway.
      let content = result.stdout.trim();
      const fenceMatch = content.match(/^```(?:typescript|ts)?\n([\s\S]*?)\n?```$/);
      if (fenceMatch) content = fenceMatch[1].trim();

      return Effect.succeed(content);
    },
  );
}

export async function generateTestContent(
  prompt: string,
  exec: ExecFn,
  signal: AbortSignal | undefined,
): Promise<string> {
  return await Effect.runPromise(generateTestContentEffect(prompt, exec), { signal });
}

// ─── Test execution ───────────────────────────────────────────────────────────

/**
 * Run Vitest for the catching test file.
 * Returns pass/fail and the combined output.
 */
export function runCatchingTestsEffect(
  extDir: string,
  extName: string,
  exec: ExecFn,
): Effect.Effect<{ passed: boolean; output: string }, ExecPhaseError> {
  const testFile = join("__tests__", `${extName}.catching.test.ts`);

  return Effect.map(
    execEffect("run catching tests", exec, "npm", ["test", "--", testFile], {
      cwd: extDir,
      timeout: 60_000,
    }),
    (result) => {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      return { passed: result.code === 0, output };
    },
  );
}

export async function runCatchingTests(
  extDir: string,
  extName: string,
  exec: ExecFn,
): Promise<{ passed: boolean; output: string }> {
  return await Effect.runPromise(runCatchingTestsEffect(extDir, extName, exec));
}

// ─── High-level orchestrator ──────────────────────────────────────────────────

/**
 * Run the full jit-catch workflow for a single extension:
 *   prepare env → generate tests → write file → run tests → discard on pass.
 */
export function runForExtensionEffect(
  ext: ExtensionDiff,
  diffText: string,
  exec: ExecFn,
  workspaceRoot: string,
  onProgress?: (phase: string) => void,
): Effect.Effect<ExtensionRunResult, FsPhaseError | ExecPhaseError> {
  return Effect.gen(function*() {
    const extDir = resolveExtensionDir(ext, workspaceRoot);

    if (!existsSync(extDir)) {
      return {
        extName: ext.name,
        passed: false,
        testOutput: `Extension directory not found: ${extDir}`,
        testPath: null,
      };
    }

    // 1. Prepare environment
    yield* fsEffect("prepare environment", extDir, () => prepareEnv(extDir, ext.name));

    // 2. Read source files for context
    onProgress?.("reading source files…");
    const sourceContent = readSourceFiles(ext.changedFiles, workspaceRoot);

    // 3. Build prompt and generate tests via subagent
    onProgress?.("generating tests via subagent…");
    const prompt = buildTestPrompt(ext, diffText, sourceContent, extDir);
    const generated = yield* Effect.either(generateTestContentEffect(prompt, exec));
    if (generated._tag === "Left") {
      return {
        extName: ext.name,
        passed: false,
        testOutput: `Test generation failed: ${generationErrorMessage(generated.left)}`,
        testPath: null,
      };
    }

    // 4. Write the test file
    const testPath = join(extDir, "__tests__", `${ext.name}.catching.test.ts`);
    yield* fsEffect("write catching test", testPath, () => writeFileSync(testPath, generated.right + "\n"));

    // 5. Run tests
    onProgress?.("running npm test…");
    const { passed, output } = yield* runCatchingTestsEffect(extDir, ext.name, exec);

    // 6. Auto-discard on pass only. Deletion is best-effort: failures must not
    // turn a passing run into a failed run. Failed or interrupted runs retain the file.
    if (passed) {
      yield* Effect.ignore(fsEffect("discard passing catching test", testPath, () => unlinkSync(testPath)));
      return { extName: ext.name, passed: true, testOutput: output, testPath: null };
    }

    return { extName: ext.name, passed: false, testOutput: output, testPath };
  });
}

export async function runForExtension(
  ext: ExtensionDiff,
  diffText: string,
  exec: ExecFn,
  signal: AbortSignal | undefined,
  workspaceRoot: string,
  onProgress?: (phase: string) => void,
): Promise<ExtensionRunResult> {
  const result = await Effect.runPromise(
    Effect.either(runForExtensionEffect(ext, diffText, exec, workspaceRoot, onProgress)),
    { signal },
  );

  if (result._tag === "Right") return result.right;
  return phaseErrorToRunResult(ext, result.left, workspaceRoot);
}
