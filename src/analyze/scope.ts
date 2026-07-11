import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { ScopeError, ScopeMode } from "./model.js";

export interface Hunk { start: number; end: number }
export interface Scope { mode: ScopeMode; files: readonly string[]; hunks: ReadonlyMap<string, readonly Hunk[]> }
export const intersectsHunks = (start: number, end: number, hunks: readonly Hunk[] | undefined): boolean => !hunks || hunks.some(h => start <= h.end && end >= h.start);
export function parseUnifiedHunks(text: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>(); let file: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); if (!out.has(file)) out.set(file, []); }
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (file && match) { const start = Number(match[1]); const count = match[2] === undefined ? 1 : Number(match[2]); out.get(file)!.push({ start, end: Math.max(start, start + count - 1) }); }
  } return out;
}
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const expandPath = (cwd: string, path: string): string[] => {
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [relative(cwd, absolute).replaceAll("\\", "/")];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(cwd, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/"));
};
export function resolveScope(cwd: string, mode: ScopeMode, paths: readonly string[], ref = "main"): Scope {
  try {
    if (mode === ScopeMode.Paths) {
      const files = paths.flatMap(p => expandPath(cwd, p));
      return { mode, files: [...new Set(files)].sort(), hunks: new Map() };
    }
    if (mode === ScopeMode.All) return { mode, files: [], hunks: new Map() };
    const base = git(cwd, ["merge-base", ref, "HEAD"]).trim();
    const chunks = [git(cwd, ["diff", "--unified=0", base, "HEAD"]), git(cwd, ["diff", "--unified=0", "--cached"]), git(cwd, ["diff", "--unified=0"] )];
    const hunks = new Map<string, Hunk[]>();
    for (const chunk of chunks) for (const [path, ranges] of parseUnifiedHunks(chunk)) hunks.set(path, [...(hunks.get(path) ?? []), ...ranges]);
    for (const path of git(cwd, ["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean)) hunks.set(path, [{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
    return { mode, files: [...hunks.keys()].sort(), hunks };
  } catch (cause) { throw new ScopeError({ message: cause instanceof Error ? cause.message : String(cause) }); }
}
