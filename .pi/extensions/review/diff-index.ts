import {
  diffHunkRanges,
  parseDiffGitPath,
  parseGitPathList,
  parsePatchFilePath,
  type DiffHunkRange,
} from "./core";

export interface DiffIndexEntry {
  readonly path: string;
  readonly text: string;
  readonly hunks: readonly DiffHunkRange[];
}

/** An immutable, path-keyed view of a unified Git diff. */
export interface DiffIndex extends ReadonlyMap<string, DiffIndexEntry> {}

class ImmutableDiffIndex implements DiffIndex {
  readonly #entries: ReadonlyMap<string, DiffIndexEntry>;

  constructor(entries: Iterable<readonly [string, DiffIndexEntry]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }
  get(path: string): DiffIndexEntry | undefined {
    return this.#entries.get(path);
  }
  has(path: string): boolean {
    return this.#entries.has(path);
  }
  entries(): MapIterator<[string, DiffIndexEntry]> {
    return this.#entries.entries();
  }
  keys(): MapIterator<string> {
    return this.#entries.keys();
  }
  values(): MapIterator<DiffIndexEntry> {
    return this.#entries.values();
  }
  forEach(
    callbackfn: (
      value: DiffIndexEntry,
      key: string,
      map: ReadonlyMap<string, DiffIndexEntry>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[string, DiffIndexEntry]> {
    return this.entries();
  }
}

interface IndexedSection {
  readonly path: string;
  readonly text: string;
  readonly hunks: readonly DiffHunkRange[];
}

function extendedDestinationPath(lines: readonly string[]): string | undefined {
  for (const prefix of ["rename to ", "copy to "] as const) {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    if (!line) continue;
    const value = line.slice(prefix.length);
    return value.startsWith('"') ? parseGitPathList(value).at(0) : value;
  }
  return undefined;
}

function canonicalSectionPath(section: string): string | undefined {
  const lines = section.split(/\r?\n/u);
  const hunkStart = lines.findIndex((line) => line.startsWith("@@ "));
  const headerLines = hunkStart < 0 ? lines : lines.slice(0, hunkStart);
  const destinationLine = headerLines.find((line) => line.startsWith("+++ "));
  const destination = destinationLine ? parsePatchFilePath(destinationLine) : undefined;
  if (destination) return destination;

  // Only an explicit /dev/null destination makes the source path canonical.
  if (destinationLine && /^\+\+\+ \/dev\/null(?:\t|$)/u.test(destinationLine)) {
    const sourceLine = headerLines.find((line) => line.startsWith("--- "));
    const source = sourceLine ? parsePatchFilePath(sourceLine) : undefined;
    if (source) return source;
  }
  return extendedDestinationPath(headerLines) ?? parseDiffGitPath(lines[0] ?? "");
}

function lineCount(text: string): number {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function sections(diff: string): readonly IndexedSection[] {
  const starts = [...diff.matchAll(/^diff --git /gmu)].map((match) => match.index);
  return starts.flatMap((start, index) => {
    const text = diff.slice(start, starts[index + 1] ?? diff.length);
    const path = canonicalSectionPath(text);
    return path ? [{ path, text, hunks: diffHunkRanges(text) }] : [];
  });
}

/**
 * Builds an immutable index keyed by destination path (or source path for a deletion).
 * Repeated file sections are concatenated and their hunk lines retain exact offsets in
 * the resulting text.
 */
export function createDiffIndex(diff: string): DiffIndex {
  const grouped = new Map<string, { text: string; hunks: DiffHunkRange[] }>();
  for (const section of sections(diff)) {
    const current = grouped.get(section.path);
    if (!current) {
      grouped.set(section.path, { text: section.text, hunks: [...section.hunks] });
      continue;
    }
    const separator = current.text.endsWith("\n") ? "" : "\n";
    const offset = lineCount(current.text);
    current.text += `${separator}${section.text}`;
    current.hunks.push(
      ...section.hunks.map((hunk) => ({
        startLine: hunk.startLine + offset,
        endLine: hunk.endLine + offset,
        header: hunk.header,
      })),
    );
  }

  return new ImmutableDiffIndex(
    [...grouped].map(([path, entry]) => [
      path,
      Object.freeze({
        path,
        text: entry.text,
        hunks: Object.freeze(entry.hunks.map((hunk) => Object.freeze({ ...hunk }))),
      }),
    ]),
  );
}
