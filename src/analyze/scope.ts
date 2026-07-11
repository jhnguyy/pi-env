import { execFileSync } from "node:child_process";
import { Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { ScopeError, ScopeMode } from "./model.js";

export interface Hunk { start: number; end: number }
export interface Scope { mode: ScopeMode; files: readonly string[]; hunks: ReadonlyMap<string, readonly Hunk[]> }

const MAX_SCOPE_FILES = 50_000 as const;
const MAX_GIT_OUTPUT_BYTES = 8_388_608;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".analyze-bundle", ".turbo", ".next", ".svelte-kit"]);
const ANALYZABLE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".yaml", ".yml"]);

export const intersectsHunks = (start: number, end: number, hunks: readonly Hunk[] | undefined): boolean => !hunks || hunks.some(h => start <= h.end && end >= h.start);
export function parseUnifiedHunks(text: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>(); let file: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); if (!out.has(file)) out.set(file, []); }
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (file && match) { const start = Number(match[1]); const count = match[2] === undefined ? 1 : Number(match[2]); out.get(file)!.push({ start, end: Math.max(start, start + count - 1) }); }
  } return out;
}

const normalize = (path: string): string => path.replaceAll("\\", "/");
const analyzablePath = (path: string): boolean => [...ANALYZABLE_EXTENSIONS].some((extension) => path.endsWith(extension));

function assertWithinScopeCap(count: number): void {
  if (count > MAX_SCOPE_FILES) throw new ScopeError({ message: `Scope file limit exceeded: discovered more than ${MAX_SCOPE_FILES} analyzable files` });
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ScopeError({ message: `git ${args.join(" ")} failed or exceeded ${MAX_GIT_OUTPUT_BYTES} bytes: ${message}` });
  }
}

function shouldSkipDirectory(entry: Dirent): boolean {
  return entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name);
}

function isSkippedRoot(relativeRoot: string): boolean {
  return [...SKIPPED_DIRECTORIES].some((name) => relativeRoot === name || relativeRoot.startsWith(`${name}/`));
}

function addAnalyzableFile(cwd: string, absolute: string, files: Set<string>, maxFiles: number = MAX_SCOPE_FILES): void {
  const relativePath = normalize(relative(cwd, absolute));
  if (!analyzablePath(relativePath)) return;
  files.add(relativePath);
  if (files.size > maxFiles) throw new ScopeError({ message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files` });
}

function walkDirectory(cwd: string, root: string, files: Set<string>, maxFiles: number = MAX_SCOPE_FILES): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (shouldSkipDirectory(entry)) continue;
      const entryPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      addAnalyzableFile(cwd, entryPath, files, maxFiles);
    }
  }
}

export function expandExplicitPaths(cwd: string, paths: readonly string[], maxFiles: number = MAX_SCOPE_FILES): string[] {
  const files = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    const relativeRoot = normalize(relative(cwd, absolute));
    if (relativeRoot === ".." || relativeRoot.startsWith("../") || relativeRoot.startsWith("/")) {
      throw new ScopeError({ message: `Explicit path resolves outside cwd: ${path}` });
    }
    if (!existsSync(absolute)) continue;
    if (isSkippedRoot(relativeRoot)) continue;
    const stats = statSync(absolute);
    if (stats.isFile()) {
      addAnalyzableFile(cwd, absolute, files, maxFiles);
      continue;
    }
    walkDirectory(cwd, absolute, files, maxFiles);
  }
  return boundedSortedFiles(files, maxFiles);
}

function boundedSortedFiles(files: Iterable<string>, maxFiles: number = MAX_SCOPE_FILES): string[] {
  const output = [...new Set(files)].sort();
  if (output.length > maxFiles) throw new ScopeError({ message: `Scope file limit exceeded: discovered more than ${maxFiles} analyzable files` });
  return output;
}

export function resolveScope(cwd: string, mode: ScopeMode, paths: readonly string[], ref = "main"): Scope {
  try {
    if (mode === ScopeMode.Paths) return { mode, files: expandExplicitPaths(cwd, paths), hunks: new Map() };
    if (mode === ScopeMode.All) return { mode, files: [], hunks: new Map() };
    const base = git(cwd, ["merge-base", ref, "HEAD"]).trim();
    const chunks = [git(cwd, ["diff", "--unified=0", base, "HEAD"]), git(cwd, ["diff", "--unified=0", "--cached"]), git(cwd, ["diff", "--unified=0"] )];
    const hunks = new Map<string, Hunk[]>();
    for (const chunk of chunks) for (const [path, ranges] of parseUnifiedHunks(chunk)) hunks.set(path, [...(hunks.get(path) ?? []), ...ranges]);
    for (const path of git(cwd, ["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean)) hunks.set(path, [{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
    return { mode, files: boundedSortedFiles(hunks.keys()), hunks };
  } catch (cause) { throw cause instanceof ScopeError ? cause : new ScopeError({ message: cause instanceof Error ? cause.message : String(cause) }); }
}
