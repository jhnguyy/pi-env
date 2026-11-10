import { opendir, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { Effect } from "effect";
import { ScopeError, ScopeMode, type ScopeSelection } from "./model.js";
import { DEFAULT_EXTERNAL_TIMEOUT_MS, ProcessService } from "./process.js";
import { isOutsideWorkspace, normalizeWorkspacePath } from "./workspace-path.js";

export interface Hunk {
  start: number;
  end: number;
}
export interface Scope {
  mode: ScopeMode;
  files: readonly string[];
  hunks: ReadonlyMap<string, readonly Hunk[]>;
}

const MAX_SCOPE_FILES = 50_000 as const;
const SCOPE_ENTRIES_PER_FILE = 16 as const;
const MAX_GIT_OUTPUT_BYTES = 8_388_608;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".analyze-bundle",
  ".turbo",
  ".next",
  ".svelte-kit",
]);
const SKIPPED_ROOTS = new Set(["tools/oxlint/anti-slop"]);
const ANALYZABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
]);

export const intersectsHunks = (
  start: number,
  end: number,
  hunks: readonly Hunk[] | undefined,
): boolean => !hunks || hunks.some((hunk) => start <= hunk.end && end >= hunk.start);

function decodeGitPath(path: string): string {
  if (!path.startsWith('"')) return path.replace(/\t$/, "");
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    '"': '"',
    "\\": "\\",
  };
  const chunks: Buffer[] = [];
  for (const token of path
    .slice(1, path.lastIndexOf('"'))
    .matchAll(/\\([0-7]{1,3}|[abfnrtv"\\])|[^\\]+/g)) {
    chunks.push(
      token[1] === undefined
        ? Buffer.from(token[0], "utf8")
        : /^[0-7]/.test(token[1])
          ? Buffer.from([Number.parseInt(token[1], 8)])
          : Buffer.from(escapes[token[1]], "utf8"),
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseUnifiedHunks(text: string): Map<string, Hunk[]> {
  const output = new Map<string, Hunk[]>();
  let file: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) file = undefined;
    if (line.startsWith("+++ ")) {
      const path = decodeGitPath(line.slice(4));
      file = path.startsWith("b/") ? path.slice(2) : undefined;
      if (file !== undefined && !output.has(file)) output.set(file, []);
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

const analyzablePath = (path: string): boolean => ANALYZABLE_EXTENSIONS.has(extname(path));
const isSkippedRoot = (relativeRoot: string): boolean =>
  [...SKIPPED_DIRECTORY_NAMES, ...SKIPPED_ROOTS].some(
    (name) => relativeRoot === name || relativeRoot.startsWith(`${name}/`),
  );
const eligibleScopePath = (path: string): boolean => {
  const normalized = normalizeWorkspacePath(path);
  return analyzablePath(normalized) && !isSkippedRoot(normalized);
};

function boundedSortedFiles(files: Iterable<string>, maxFiles: number = MAX_SCOPE_FILES): string[] {
  const output = [...new Set(files)].sort();
  if (output.length > maxFiles)
    throw new ScopeError({
      message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files`,
    });
  return output;
}

function addAnalyzableFile(
  cwd: string,
  absolute: string,
  files: Set<string>,
  maxFiles: number,
): void {
  const relativePath = normalizeWorkspacePath(relative(cwd, absolute));
  if (!analyzablePath(relativePath)) return;
  files.add(relativePath);
  if (files.size > maxFiles)
    throw new ScopeError({
      message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files`,
    });
}

const scopeError = (cause: unknown): ScopeError =>
  cause instanceof ScopeError
    ? cause
    : new ScopeError({ message: cause instanceof Error ? cause.message : String(cause) });

async function pathStats(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

interface ScopeTraversalBudget {
  visitedEntries: number;
  readonly maxEntries: number;
}

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
              throw new ScopeError({
                message: `Scope entry limit exceeded: visited more than ${budget.maxEntries} directory entries`,
              });
            }
            const entryPath = resolve(current, entry.name);
            const relativePath = normalizeWorkspacePath(relative(cwd, entryPath));
            if (
              entry.isDirectory() &&
              (SKIPPED_DIRECTORY_NAMES.has(entry.name) || isSkippedRoot(relativePath))
            )
              continue;
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
      const lexicalRoot = normalizeWorkspacePath(relative(root, absolute));
      if (isOutsideWorkspace(lexicalRoot)) {
        return yield* new ScopeError({ message: `Explicit path resolves outside cwd: ${path}` });
      }
      if (isSkippedRoot(lexicalRoot)) continue;
      const stats = yield* Effect.tryPromise({ try: () => pathStats(absolute), catch: scopeError });
      if (stats === undefined) continue;
      const resolved = yield* Effect.tryPromise({
        try: () => realpath(absolute),
        catch: scopeError,
      });
      const relativeRoot = normalizeWorkspacePath(relative(root, resolved));
      if (isOutsideWorkspace(relativeRoot)) {
        return yield* new ScopeError({ message: `Explicit path resolves outside cwd: ${path}` });
      }
      if (isSkippedRoot(relativeRoot)) continue;
      if (stats.isFile())
        yield* Effect.try({
          try: () => addAnalyzableFile(root, resolved, files, maxFiles),
          catch: scopeError,
        });
      else if (stats.isDirectory())
        yield* walkDirectoryEffect(root, resolved, files, maxFiles, traversalBudget);
    }
    return yield* Effect.try({ try: () => boundedSortedFiles(files, maxFiles), catch: scopeError });
  }).pipe(Effect.mapError(scopeError));
}

function gitEffect(
  cwd: string,
  args: readonly string[],
): Effect.Effect<string, ScopeError, ProcessService> {
  return Effect.flatMap(ProcessService, ({ run }) =>
    run("git", args, {
      cwd,
      timeoutMs: DEFAULT_EXTERNAL_TIMEOUT_MS,
      stdoutLimitBytes: MAX_GIT_OUTPUT_BYTES,
      stderrLimitBytes: MAX_GIT_OUTPUT_BYTES,
    }),
  ).pipe(
    Effect.map(({ stdout }) => stdout),
    Effect.mapError(
      (cause) =>
        new ScopeError({
          message: `git ${args.join(" ")} failed or exceeded ${MAX_GIT_OUTPUT_BYTES} bytes: ${cause.message}`,
        }),
    ),
  );
}

export function resolveScopeEffect(
  request: ScopeSelection & { readonly cwd: string },
  maxFiles: number = MAX_SCOPE_FILES,
): Effect.Effect<Scope, ScopeError, ProcessService> {
  if (request.scope === ScopeMode.Paths) {
    return expandExplicitPathsEffect(request.cwd, request.paths, maxFiles).pipe(
      Effect.map((files) => ({ mode: request.scope, files, hunks: new Map() })),
    );
  }
  if (request.scope === ScopeMode.All) {
    return Effect.succeed({ mode: request.scope, files: [], hunks: new Map() });
  }
  return Effect.gen(function* () {
    const base = (yield* gitEffect(request.cwd, [
      "merge-base",
      request.ref ?? "main",
      "HEAD",
    ])).trim();
    // Compare the base directly with the worktree. Each hunk then uses the
    // same line numbers as the source files that the analyzers parse.
    const chunks = [
      yield* gitEffect(request.cwd, [
        "diff",
        "--relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=0",
        base,
        "--",
        ".",
      ]),
    ];
    const hunks = new Map<string, Hunk[]>();
    yield* Effect.try({
      try: () => {
        for (const chunk of chunks) {
          for (const [path, ranges] of parseUnifiedHunks(chunk)) {
            if (!eligibleScopePath(path)) continue;
            hunks.set(path, [...(hunks.get(path) ?? []), ...ranges]);
            if (hunks.size > maxFiles)
              throw new ScopeError({
                message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files`,
              });
          }
        }
      },
      catch: scopeError,
    });
    const untracked = yield* gitEffect(request.cwd, [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ".",
    ]);
    yield* Effect.try({
      try: () => {
        for (const path of untracked.split("\0").filter(eligibleScopePath)) {
          hunks.set(normalizeWorkspacePath(path), [{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
          if (hunks.size > maxFiles)
            throw new ScopeError({
              message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files`,
            });
        }
      },
      catch: scopeError,
    });
    const files = yield* Effect.try({
      try: () => boundedSortedFiles(hunks.keys(), maxFiles),
      catch: scopeError,
    });
    return { mode: request.scope, files, hunks };
  });
}
