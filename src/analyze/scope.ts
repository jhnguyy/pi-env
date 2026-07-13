import { opendir, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { Effect } from "effect";
import { ScopeError, ScopeMode } from "./model.js";
import { DEFAULT_EXTERNAL_TIMEOUT_MS, ProcessService } from "./process.js";

export interface Hunk { start: number; end: number }
export interface Scope { mode: ScopeMode; files: readonly string[]; hunks: ReadonlyMap<string, readonly Hunk[]> }

const MAX_SCOPE_FILES = 50_000 as const;
const SCOPE_ENTRIES_PER_FILE = 16 as const;
const MAX_GIT_OUTPUT_BYTES = 8_388_608;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".analyze-bundle", ".turbo", ".next", ".svelte-kit"]);
const ANALYZABLE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".yaml", ".yml"]);

export const intersectsHunks = (start: number, end: number, hunks: readonly Hunk[] | undefined): boolean => !hunks || hunks.some((hunk) => start <= hunk.end && end >= hunk.start);

export function parseUnifiedHunks(text: string): Map<string, Hunk[]> {
  const output = new Map<string, Hunk[]>();
  let file: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      if (!output.has(file)) output.set(file, []);
    }
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (file !== undefined && match !== null) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      output.get(file)!.push({ start, end: Math.max(start, start + count - 1) });
    }
  }
  return output;
}

const normalize = (path: string): string => path.replaceAll("\\", "/");
const analyzablePath = (path: string): boolean => ANALYZABLE_EXTENSIONS.has(extname(path));
const isSkippedRoot = (relativeRoot: string): boolean => [...SKIPPED_DIRECTORIES].some((name) => relativeRoot === name || relativeRoot.startsWith(`${name}/`));
const eligibleScopePath = (path: string): boolean => {
  const normalized = normalize(path);
  return analyzablePath(normalized) && !isSkippedRoot(normalized);
};

function boundedSortedFiles(files: Iterable<string>, maxFiles: number = MAX_SCOPE_FILES): string[] {
  const output = [...new Set(files)].sort();
  if (output.length > maxFiles) throw new ScopeError({ message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files` });
  return output;
}

function addAnalyzableFile(cwd: string, absolute: string, files: Set<string>, maxFiles: number): void {
  const relativePath = normalize(relative(cwd, absolute));
  if (!analyzablePath(relativePath)) return;
  files.add(relativePath);
  if (files.size > maxFiles) throw new ScopeError({ message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files` });
}

const scopeError = (cause: unknown): ScopeError => cause instanceof ScopeError
  ? cause
  : new ScopeError({ message: cause instanceof Error ? cause.message : String(cause) });

async function pathStats(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try { return await stat(path); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

interface ScopeTraversalBudget { visitedEntries: number; readonly maxEntries: number }

function walkDirectoryEffect(
  cwd: string,
  root: string,
  files: Set<string>,
  maxFiles: number,
  budget: ScopeTraversalBudget,
): Effect.Effect<void, ScopeError> {
  return Effect.gen(function* () {
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      yield* Effect.tryPromise({
        try: async (signal) => {
          const directory = await opendir(current);
          for await (const entry of directory) {
            signal.throwIfAborted();
            budget.visitedEntries++;
            if (budget.visitedEntries > budget.maxEntries) {
              throw new ScopeError({ message: `Scope entry limit exceeded: visited more than ${budget.maxEntries} directory entries` });
            }
            if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
            const entryPath = resolve(current, entry.name);
            if (entry.isDirectory()) stack.push(entryPath);
            else if (entry.isFile()) addAnalyzableFile(cwd, entryPath, files, maxFiles);
          }
        },
        catch: scopeError,
      });
      yield* Effect.yieldNow;
    }
  });
}

export function expandExplicitPathsEffect(
  cwd: string,
  paths: readonly string[],
  maxFiles: number = MAX_SCOPE_FILES,
  maxEntries: number = maxFiles * SCOPE_ENTRIES_PER_FILE,
): Effect.Effect<string[], ScopeError> {
  return Effect.gen(function* () {
    const files = new Set<string>();
    const traversalBudget: ScopeTraversalBudget = { visitedEntries: 0, maxEntries };
    const root = yield* Effect.tryPromise({ try: () => realpath(cwd), catch: scopeError });
    for (const path of paths) {
      const absolute = resolve(root, path);
      const lexicalRoot = normalize(relative(root, absolute));
      if (lexicalRoot === ".." || lexicalRoot.startsWith("../") || lexicalRoot.startsWith("/")) {
        return yield* new ScopeError({ message: `Explicit path resolves outside cwd: ${path}` });
      }
      if (isSkippedRoot(lexicalRoot)) continue;
      const stats = yield* Effect.tryPromise({ try: () => pathStats(absolute), catch: scopeError });
      if (stats === undefined) continue;
      const resolved = yield* Effect.tryPromise({ try: () => realpath(absolute), catch: scopeError });
      const relativeRoot = normalize(relative(root, resolved));
      if (relativeRoot === ".." || relativeRoot.startsWith("../") || relativeRoot.startsWith("/")) {
        return yield* new ScopeError({ message: `Explicit path resolves outside cwd: ${path}` });
      }
      if (isSkippedRoot(relativeRoot)) continue;
      if (stats.isFile()) yield* Effect.try({ try: () => addAnalyzableFile(root, resolved, files, maxFiles), catch: scopeError });
      else if (stats.isDirectory()) yield* walkDirectoryEffect(root, resolved, files, maxFiles, traversalBudget);
    }
    return yield* Effect.try({ try: () => boundedSortedFiles(files, maxFiles), catch: scopeError });
  }).pipe(Effect.mapError(scopeError));
}

function gitEffect(cwd: string, args: readonly string[]): Effect.Effect<string, ScopeError, ProcessService> {
  return Effect.flatMap(ProcessService, ({ run }) => run("git", args, {
    cwd,
    timeoutMs: DEFAULT_EXTERNAL_TIMEOUT_MS,
    stdoutLimitBytes: MAX_GIT_OUTPUT_BYTES,
    stderrLimitBytes: MAX_GIT_OUTPUT_BYTES,
  })).pipe(
    Effect.map(({ stdout }) => stdout),
    Effect.mapError((cause) => new ScopeError({ message: `git ${args.join(" ")} failed or exceeded ${MAX_GIT_OUTPUT_BYTES} bytes: ${cause.message}` })),
  );
}

export function resolveScopeEffect(cwd: string, mode: ScopeMode, paths: readonly string[], ref = "main", maxFiles: number = MAX_SCOPE_FILES): Effect.Effect<Scope, ScopeError, ProcessService> {
  if (mode === ScopeMode.Paths) return expandExplicitPathsEffect(cwd, paths, maxFiles).pipe(Effect.map((files) => ({ mode, files, hunks: new Map() })));
  if (mode === ScopeMode.All) return Effect.succeed({ mode, files: [], hunks: new Map() });
  return Effect.gen(function* () {
    const base = (yield* gitEffect(cwd, ["merge-base", ref, "HEAD"])).trim();
    // Compare the base directly with the worktree so every hunk uses the same
    // line-number coordinate system as the source files parsed by analyzers.
    const chunks = [yield* gitEffect(cwd, ["diff", "--unified=0", base])];
    const hunks = new Map<string, Hunk[]>();
    yield* Effect.try({
      try: () => {
        for (const chunk of chunks) {
          for (const [path, ranges] of parseUnifiedHunks(chunk)) {
            if (!eligibleScopePath(path)) continue;
            hunks.set(path, [...(hunks.get(path) ?? []), ...ranges]);
            if (hunks.size > maxFiles) throw new ScopeError({ message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files` });
          }
        }
      },
      catch: scopeError,
    });
    const untracked = (yield* gitEffect(cwd, ["ls-files", "--others", "--exclude-standard"])).trim();
    yield* Effect.try({
      try: () => {
        for (const path of untracked.split("\n").filter(eligibleScopePath)) {
          hunks.set(normalize(path), [{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
          if (hunks.size > maxFiles) throw new ScopeError({ message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files` });
        }
      },
      catch: scopeError,
    });
    const files = yield* Effect.try({ try: () => boundedSortedFiles(hunks.keys(), maxFiles), catch: scopeError });
    return { mode, files, hunks };
  });
}
