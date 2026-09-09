export interface DiffHunkRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly header: string;
}

export type DiffAnchorSide = "LEFT" | "RIGHT";
export interface DiffAnchorOffsets {
  readonly LEFT: ReadonlyMap<number, readonly number[]>;
  readonly RIGHT: ReadonlyMap<number, readonly number[]>;
}

export interface DiffIndexEntry {
  readonly path: string;
  readonly text: string;
  readonly hunks: readonly DiffHunkRange[];
  /** Character offsets of lines addressable on each GitHub review side. */
  readonly anchors: DiffAnchorOffsets;
}

/** An immutable, canonical-path-keyed view of a unified Git diff. */
export interface DiffIndex extends ReadonlyMap<string, DiffIndexEntry> {}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: ReadonlyMap<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }
  get(path: K): V | undefined {
    return this.#entries.get(path);
  }
  has(path: K): boolean {
    return this.#entries.has(path);
  }
  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
  keys(): MapIterator<K> {
    return this.#entries.keys();
  }
  values(): MapIterator<V> {
    return this.#entries.values();
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#entries) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

function decodeGitQuotedPath(path: string): string {
  const bytes: number[] = [];
  for (let i = 1; i < path.length - 1; i += 1) {
    const ch = path[i];
    if (ch !== "\\") {
      bytes.push(ch.charCodeAt(0));
      continue;
    }
    const next = path[++i];
    if (next === undefined) throw new Error("Invalid Git quoted path.");
    if (/[0-7]/u.test(next)) {
      let octal = next;
      for (let n = 0; n < 2 && /[0-7]/u.test(path[i + 1] ?? ""); n += 1) octal += path[++i];
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const escapes: Record<string, number> = {
      "\\": 0x5c,
      '"': 0x22,
      n: 0x0a,
      t: 0x09,
      r: 0x0d,
      b: 0x08,
      f: 0x0c,
      v: 0x0b,
      a: 0x07,
    };
    bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

function quotedGitPathEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') return index;
  }
  throw new Error("Unterminated Git quoted path.");
}

export function parseGitPathList(text: string): string[] {
  const paths: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (text[index] === " " || text[index] === "\t") index += 1;
    if (index >= text.length) break;
    if (text[index] === '"') {
      const end = quotedGitPathEnd(text, index);
      paths.push(decodeGitQuotedPath(text.slice(index, end + 1)));
      index = end + 1;
      if (index < text.length && text[index] !== " " && text[index] !== "\t")
        throw new Error("Invalid Git path separator.");
      continue;
    }
    const start = index;
    while (index < text.length && text[index] !== " " && text[index] !== "\t") index += 1;
    paths.push(text.slice(start, index));
  }
  return paths;
}

function stripGitPrefix(path: string, prefix: "a" | "b"): string | undefined {
  if (path === "/dev/null") return undefined;
  return path.startsWith(`${prefix}/`) ? path.slice(2) : undefined;
}

export function parseDiffGitPath(line: string): string | undefined {
  if (!line.startsWith("diff --git ")) return undefined;
  const rest = line.slice("diff --git ".length);
  if (!rest.startsWith('"') && rest.startsWith("a/")) {
    for (
      let separator = rest.indexOf(" b/");
      separator >= 0;
      separator = rest.indexOf(" b/", separator + 1)
    ) {
      const oldPath = rest.slice(2, separator);
      const newPath = rest.slice(separator + 3);
      if (oldPath === newPath) return newPath;
    }
    const separator = rest.indexOf(" b/");
    if (separator >= 0) return rest.slice(separator + 3);
  }
  const parts = parseGitPathList(rest);
  if (parts.length !== 2) return undefined;
  return stripGitPrefix(parts[1] ?? "", "b");
}

export function parsePatchFilePath(line: string): string | undefined {
  const match = line.match(/^(---|\+\+\+) (.+?)(?:\t.*)?$/u);
  if (!match) return undefined;
  const path = match[2]?.startsWith('"') ? parseGitPathList(match[2]).at(0) : match[2];
  return stripGitPrefix(path ?? "", match[1] === "---" ? "a" : "b");
}

export function diffHunkRanges(section: string): DiffHunkRange[] {
  const lines = section.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const starts = lines.flatMap((line, index) =>
    line.startsWith("@@ ") ? [{ startLine: index + 1, header: line }] : [],
  );
  return starts.map((hunk, index) => ({
    ...hunk,
    endLine: (starts[index + 1]?.startLine ?? lines.length + 1) - 1,
  }));
}

function extendedDestinationPath(lines: readonly string[]): string | undefined {
  const line = lines.find((candidate) => /^(rename|copy) to /u.test(candidate));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(" to ") + 4);
  return value.startsWith('"') ? parseGitPathList(value).at(0) : value;
}

function canonicalSectionPath(section: string): string | undefined {
  const lines = section.split(/\r?\n/u);
  const hunkStart = lines.findIndex((line) => line.startsWith("@@ "));
  const headers = hunkStart < 0 ? lines : lines.slice(0, hunkStart);
  const destinationLine = headers.find((line) => line.startsWith("+++ "));
  const destination = destinationLine ? parsePatchFilePath(destinationLine) : undefined;
  if (destination) return destination;
  if (destinationLine && /^\+\+\+ \/dev\/null(?:\t|$)/u.test(destinationLine)) {
    const sourceLine = headers.find((line) => line.startsWith("--- "));
    const source = sourceLine ? parsePatchFilePath(sourceLine) : undefined;
    if (source) return source;
  }
  return extendedDestinationPath(headers) ?? parseDiffGitPath(lines[0] ?? "");
}

function addOffset(map: Map<number, number[]>, line: number, offset: number): void {
  const offsets = map.get(line);
  if (offsets) offsets.push(offset);
  else map.set(line, [offset]);
}

interface DiffPosition {
  oldLine: number;
  newLine: number;
}

function indexAnchorLine(
  anchors: { LEFT: Map<number, number[]>; RIGHT: Map<number, number[]> },
  position: DiffPosition,
  line: string,
  offset: number,
): void {
  if (line.startsWith("+")) addOffset(anchors.RIGHT, position.newLine++, offset);
  else if (line.startsWith("-")) addOffset(anchors.LEFT, position.oldLine++, offset);
  else if (line.startsWith(" ")) {
    addOffset(anchors.LEFT, position.oldLine++, offset);
    addOffset(anchors.RIGHT, position.newLine++, offset);
  }
}

function sectionAnchorOffsets(section: string): DiffAnchorOffsets {
  const anchors = { LEFT: new Map<number, number[]>(), RIGHT: new Map<number, number[]>() };
  const position: DiffPosition = { oldLine: 0, newLine: 0 };
  let inHunk = false;
  for (const match of section.matchAll(/^(.*?)(?:\r?\n|$)/gmu)) {
    if (match[0] === "") break;
    const line = match[1] ?? "";
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      position.oldLine = Number(hunk[1]);
      position.newLine = Number(hunk[2]);
      inHunk = true;
    } else if (line.startsWith("diff --git ")) inHunk = false;
    else if (inHunk) indexAnchorLine(anchors, position, line, match.index);
  }
  const freezeSide = (side: Map<number, number[]>) =>
    new ImmutableMap([...side].map(([line, offsets]) => [line, Object.freeze(offsets)] as const));
  return Object.freeze({ LEFT: freezeSide(anchors.LEFT), RIGHT: freezeSide(anchors.RIGHT) });
}

interface MutableEntry {
  text: string;
  lines: number;
  hunks: DiffHunkRange[];
}

function lineCount(text: string): number {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** Builds one immutable index, retaining repeated sections and exact anchor offsets. */
export function createDiffIndex(diff: string): DiffIndex {
  const starts = [...diff.matchAll(/^diff --git /gmu)].map((match) => match.index);
  const grouped = new Map<string, MutableEntry>();
  starts.forEach((start, index) => {
    const text = diff.slice(start, starts[index + 1] ?? diff.length);
    const path = canonicalSectionPath(text);
    if (!path) return;
    const current = grouped.get(path);
    if (!current) {
      grouped.set(path, { text, lines: lineCount(text), hunks: diffHunkRanges(text) });
      return;
    }
    const separator = current.text.endsWith("\n") ? "" : "\n";
    const lineOffset = current.lines;
    current.lines += lineCount(text);
    current.text += `${separator}${text}`;
    current.hunks.push(
      ...diffHunkRanges(text).map((hunk) => ({
        ...hunk,
        startLine: hunk.startLine + lineOffset,
        endLine: hunk.endLine + lineOffset,
      })),
    );
  });

  return new ImmutableMap(
    [...grouped].map(([path, entry]) => {
      let anchors: DiffAnchorOffsets | undefined;
      return [
        path,
        Object.freeze({
          path,
          text: entry.text,
          hunks: Object.freeze(entry.hunks.map((hunk) => Object.freeze(hunk))),
          get anchors() {
            return (anchors ??= sectionAnchorOffsets(entry.text));
          },
        }),
      ] as const;
    }),
  );
}

export function diffAnchors(diff: string): Map<string, { LEFT: Set<number>; RIGHT: Set<number> }> {
  return new Map(
    [...createDiffIndex(diff)].map(([path, entry]) => [
      path,
      { LEFT: new Set(entry.anchors.LEFT.keys()), RIGHT: new Set(entry.anchors.RIGHT.keys()) },
    ]),
  );
}

export function changedLineAnchors(diff: string): Map<string, Set<number>> {
  return new Map([...diffAnchors(diff)].map(([path, anchors]) => [path, anchors.RIGHT]));
}

export function parseChangedFilesFromDiff(diff: string): Array<{ path: string }> {
  return [...createDiffIndex(diff).keys()].map((path) => ({ path }));
}
