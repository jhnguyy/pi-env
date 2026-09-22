/**
 * Runner — all side-effectful operations for jit-catch.
 *
 * Responsibilities:
 * - Acquire a diff via git (or accept a raw diff string)
 * - Read source file contents to enrich the subagent prompt
 * - Spawn a pi subagent that outputs test content to stdout
 * - Write the catching test file
 * - Run the owning repository's test script and return pass/fail + output
 * - Auto-discard on pass
 *
 * JitRunner is injected for testability; production uses the shared process platform.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { Data, Effect, Result } from "effect";
import { runProcess, type ProcessFailure } from "../../../src/process/platform.js";
import type { ExtensionDiff, ExtensionRunResult } from "./types";

export type ExecResult = { code: number; stdout: string; stderr: string };

export type JitRunner = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; timeout?: number },
) => Effect.Effect<ExecResult, ProcessFailure>;

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

function runWithPhase(
  phase: string,
  runner: JitRunner,
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; timeout?: number },
): Effect.Effect<ExecResult, ExecPhaseError> {
  return runner(cmd, args, opts).pipe(
    Effect.mapError(
      (error) => new ExecPhaseError({ phase, command: [cmd, ...args].join(" "), cause: error }),
    ),
  );
}

export const platformJitRunner: JitRunner = (cmd, args, opts = {}) =>
  runProcess(cmd, args, { cwd: opts.cwd, timeoutMs: opts.timeout }).pipe(
    Effect.map((result) => ({
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    })),
  );

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
export function resolveGitRootEffect(
  runner: JitRunner,
  gitCwd: string,
): Effect.Effect<string, ExecPhaseError> {
  return Effect.map(
    runWithPhase("resolve git root", runner, "git", ["rev-parse", "--show-toplevel"], {
      cwd: gitCwd,
    }),
    (result) => (result.code === 0 && result.stdout.trim() ? result.stdout.trim() : gitCwd),
  );
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
  runner: JitRunner,
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
        return Effect.fail(
          new UserPhaseError({
            phase: "capture diff",
            message: "diff_source='commit' requires a commit SHA",
          }),
        );
      }
      args = ["show", commit];
      break;
  }

  return Effect.flatMap(
    runWithPhase("capture diff", runner, "git", args, { cwd: gitCwd }),
    (result) => {
      if (result.code !== 0) {
        return Effect.fail(
          new UserPhaseError({
            phase: "capture diff",
            message: `git ${args[0]} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
          }),
        );
      }

      if (!result.stdout.trim()) {
        return Effect.fail(
          new UserPhaseError({
            phase: "capture diff",
            message:
              `git ${args[0]} produced no output — nothing to verify. ` +
              `If changes are outside a git repo, pass the diff directly via the 'diff' parameter.`,
          }),
        );
      }

      return Effect.succeed(result.stdout);
    },
  );
}

// ─── Environment prep ─────────────────────────────────────────────────────────

/** Ensure the extension has a diagnostic directory. Idempotent. */
export function prepareEnv(extDir: string, _extName: string): void {
  mkdirSync(join(extDir, "__tests__"), { recursive: true });
}

interface RepositoryTestCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

const packageManagerCommands: Record<string, (filter: string) => readonly string[]> = {
  nub: (filter) => ["run", "test", filter],
  npm: (filter) => ["test", "--", filter],
  pnpm: (filter) => ["test", "--", filter],
  yarn: (filter) => ["test", filter],
  bun: (filter) => ["run", "test", filter],
};

function detectedPackageManager(workspaceRoot: string, declared: unknown): string | undefined {
  if (typeof declared === "string" && declared.trim()) return declared.split("@")[0];
  if (existsSync(join(workspaceRoot, "nub.lock"))) return "nub";
  if (existsSync(join(workspaceRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(workspaceRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(workspaceRoot, "bun.lock")) || existsSync(join(workspaceRoot, "bun.lockb")))
    return "bun";
  if (existsSync(join(workspaceRoot, "package-lock.json"))) return "npm";
  return undefined;
}

function readRepositoryPackage(workspaceRoot: string): { packageManager?: unknown } {
  const packagePath = join(workspaceRoot, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error(`Repository has no package.json at ${packagePath}`);
  }

  const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Repository package.json is not an object: ${packagePath}`);
  }
  const pkg = parsed as { packageManager?: unknown; scripts?: unknown };
  const scripts = pkg.scripts;
  const testScript =
    typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>).test
      : undefined;
  if (typeof testScript !== "string" || !testScript.trim()) {
    throw new Error(`Repository package.json has no usable test script: ${packagePath}`);
  }

  return pkg;
}

export function resolveRepositoryTestCommand(
  workspaceRoot: string,
  testPath: string,
): RepositoryTestCommand {
  const pkg = readRepositoryPackage(workspaceRoot);
  const packageManager = detectedPackageManager(workspaceRoot, pkg.packageManager);
  const makeArgs =
    packageManager !== undefined && Object.hasOwn(packageManagerCommands, packageManager)
      ? packageManagerCommands[packageManager]
      : undefined;
  if (!packageManager || !makeArgs) {
    throw new Error(
      `Repository has no supported package-manager configuration at ${workspaceRoot}`,
    );
  }

  const filter = relative(workspaceRoot, testPath).split(sep).join("/");
  if (!filter || filter === ".." || filter.startsWith("../") || isAbsolute(filter)) {
    throw new Error(`Generated test is outside the repository workspace: ${testPath}`);
  }

  return { command: packageManager, args: makeArgs(filter), cwd: workspaceRoot };
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
    const candidates = [join(workspaceRoot, relPath), join(homedir(), relPath), join("/", relPath)];

    let content: string | null = null;
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try {
          content = readFileSync(candidate, "utf-8");
          break;
        } catch {
          /* skip */
        }
      }
    }

    if (content === null) continue;

    const remaining = MAX_SOURCE_BYTES - totalBytes;
    if (remaining <= 0) break;

    const truncated =
      content.length > remaining ? content.slice(0, remaining) + "\n// ... (truncated)" : content;

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
  behavior: string,
): string {
  const testPath = join(extDir, "__tests__", `${ext.name}.catching.test.ts`);

  return [
    `You are a test writer for a pi extension. Generate catching tests for the following diff.`,
    ``,
    `Extension: ${ext.name}`,
    `Source files changed (one per line):`,
    ext.changedFiles.map((f) => `  ${f}`).join("\n"),
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
    `## Temporary experiment`,
    ``,
    `Named observable behavior or failure: ${behavior}`,
    `Design the smallest focused experiment that can observe this behavior through the changed extension.`,
    `Use the diff and source only to find the relevant boundary and arrange the observation.`,
    `This is explicitly exploratory catching evidence, not a permanent regression or unit-test candidate.`,
    `Do not broaden the experiment to unchanged behavior or infer a test quota.`,
    `Use the repository's existing test style; if none is visible, use Vitest named imports.`,
    `Output ONLY the TypeScript test file content. No explanation or markdown fences.`,
    `The content will be written directly to: ${testPath}`,
  ].join("\n");
}

// ─── Test generation ──────────────────────────────────────────────────────────

/**
 * Spawn a pi subagent to generate the catching test content.
 * Returns the raw TypeScript source that should be written to the test file.
 */
export function generateTestContentEffect(
  prompt: string,
  runner: JitRunner,
): Effect.Effect<string, UserPhaseError | ExecPhaseError> {
  return Effect.flatMap(
    runWithPhase(
      "generate tests",
      runner,
      "pi",
      ["--print", "--no-session", "--no-skills", "--no-extensions", "--tools", "", prompt],
      { timeout: 90_000 },
    ),
    (result) => {
      if (result.code !== 0) {
        return Effect.fail(
          new UserPhaseError({
            phase: "generate tests",
            message: `Test-writer subagent failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`,
          }),
        );
      }

      // Strip markdown fences if the model wrapped the output anyway.
      let content = result.stdout.trim();
      const fenceMatch = content.match(/^```(?:typescript|ts)?\n([\s\S]*?)\n?```$/);
      if (fenceMatch) content = fenceMatch[1].trim();

      return Effect.succeed(content);
    },
  );
}

// ─── Test execution ───────────────────────────────────────────────────────────

/** Run the repository-owned test script and return pass/fail with combined output. */
export function runCatchingTestsEffect(
  testCommand: RepositoryTestCommand,
  runner: JitRunner,
): Effect.Effect<{ passed: boolean; output: string }, ExecPhaseError> {
  return Effect.map(
    runWithPhase("run catching tests", runner, testCommand.command, testCommand.args, {
      cwd: testCommand.cwd,
      timeout: 60_000,
    }),
    (result) => {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      return { passed: result.code === 0, output };
    },
  );
}

// ─── High-level orchestrator ──────────────────────────────────────────────────

/**
 * Run the full jit-catch workflow for a single extension:
 *   validate repository runner → prepare directory → generate → run → discard on pass.
 */
export function runForExtensionEffect(
  ext: ExtensionDiff,
  diffText: string,
  runner: JitRunner,
  workspaceRoot: string,
  behavior: string,
  onProgress?: (phase: string) => void,
): Effect.Effect<ExtensionRunResult, FsPhaseError | ExecPhaseError> {
  return Effect.gen(function* () {
    const extDir = resolveExtensionDir(ext, workspaceRoot);

    if (!existsSync(extDir)) {
      return {
        extName: ext.name,
        passed: false,
        testOutput: `Extension directory not found: ${extDir}`,
        testPath: null,
      };
    }

    const testPath = join(extDir, "__tests__", `${ext.name}.catching.test.ts`);

    // Resolve repository-owned execution before generation or filesystem writes.
    const testCommand = yield* fsEffect(
      "resolve repository test command",
      join(workspaceRoot, "package.json"),
      () => resolveRepositoryTestCommand(workspaceRoot, testPath),
    );

    // 1. Prepare the diagnostic location without inventing repository tooling.
    yield* fsEffect("prepare environment", extDir, () => prepareEnv(extDir, ext.name));

    // 2. Read source files for context
    onProgress?.("reading source files…");
    const sourceContent = readSourceFiles(ext.changedFiles, workspaceRoot);

    // 3. Build prompt and generate tests via subagent
    onProgress?.("generating tests via subagent…");
    const prompt = buildTestPrompt(ext, diffText, sourceContent, extDir, behavior);
    const generated = yield* Effect.result(generateTestContentEffect(prompt, runner));
    if (Result.isFailure(generated)) {
      return {
        extName: ext.name,
        passed: false,
        testOutput: `Test generation failed: ${generationErrorMessage(generated.failure)}`,
        testPath: null,
      };
    }

    // 4. Write the test file
    yield* fsEffect("write catching test", testPath, () =>
      writeFileSync(testPath, generated.success + "\n"),
    );

    // 5. Run tests
    onProgress?.("running repository test script…");
    const { passed, output } = yield* runCatchingTestsEffect(testCommand, runner);

    // 6. Auto-discard on pass only. Deletion is best-effort: failures must not
    // turn a passing run into a failed run. Failed or interrupted runs retain the file.
    if (passed) {
      yield* Effect.ignore(
        fsEffect("discard passing catching test", testPath, () => unlinkSync(testPath)),
      );
      return { extName: ext.name, passed: true, testOutput: output, testPath: null };
    }

    return { extName: ext.name, passed: false, testOutput: output, testPath };
  });
}
