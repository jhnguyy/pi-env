import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";

import {
  NotesProviderError,
  type ExactEdit,
  type NoteEntry,
  type NoteSearchResult,
  type NotesProvider,
} from "./domain";

const MARKDOWN_EXTENSION = ".md";
const INDEX_ENTRY_NAMES = new Set(["_index.md", "overview.md"]);
const MAX_SEARCH_RESULTS = 100;

export function createObsidianProviderEffect(
  vaultPath: string,
): Effect.Effect<NotesProvider, NotesProviderError> {
  return ioEffect(async () => {
    const root = await realpath(vaultPath);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new NotesProviderError({
        code: "not-a-note",
        message: `Obsidian vault is not a directory: ${vaultPath}`,
      });
    }
    return new ObsidianProvider(root);
  }, `Cannot open Obsidian vault: ${vaultPath}`);
}

class ObsidianProvider implements NotesProvider {
  readonly id = "obsidian" as const;

  constructor(readonly root: string) {}

  index(): Effect.Effect<string, NotesProviderError> {
    return Effect.map(this.list(), (notes) => formatIndex(notes));
  }

  list(prefix?: string): Effect.Effect<readonly NoteEntry[], NotesProviderError> {
    return ioEffect(async (signal) => {
      const normalizedPrefix = prefix === undefined ? undefined : normalizePrefix(prefix);
      const paths = await walkMarkdownFiles(this.root, this.root, signal);
      const matching = normalizedPrefix
        ? paths.filter((notePath) => notePath.startsWith(normalizedPrefix))
        : paths;
      const entries: NoteEntry[] = [];
      for (const notePath of matching) {
        signal.throwIfAborted();
        const metadata = await stat(path.join(this.root, ...notePath.split("/")));
        entries.push({
          path: notePath,
          size: metadata.size,
          modifiedAt: metadata.mtimeMs,
        });
      }
      return entries.sort((left, right) => left.path.localeCompare(right.path));
    }, "Cannot list Obsidian notes");
  }

  read(notePath: string): Effect.Effect<string, NotesProviderError> {
    return ioEffect(async (signal) => {
      const target = await this.resolveExistingNote(notePath);
      return readFile(target.canonical, { encoding: "utf8", signal });
    }, `Cannot read note: ${notePath}`);
  }

  search(query: string): Effect.Effect<readonly NoteSearchResult[], NotesProviderError> {
    if (query.trim().length === 0) {
      return Effect.fail(
        new NotesProviderError({
          code: "invalid-path",
          message: "Notes search requires a non-empty query.",
        }),
      );
    }

    return Effect.flatMap(this.list(), (notes) =>
      ioEffect(async (signal) => {
        const needle = query.toLocaleLowerCase();
        const results: NoteSearchResult[] = [];
        for (const note of notes) {
          signal.throwIfAborted();
          const target = await this.resolveExistingNote(note.path);
          const content = await readFile(target.canonical, { encoding: "utf8", signal });
          const pathMatch = note.path.toLocaleLowerCase().includes(needle);
          const contentMatch = content.toLocaleLowerCase().includes(needle);
          if (!pathMatch && !contentMatch) continue;
          results.push({
            path: note.path,
            title: markdownTitle(content),
            snippet: matchingSnippet(content, needle),
          });
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
        return results;
      }, `Cannot search notes for: ${query}`),
    );
  }

  write(notePath: string, content: string): Effect.Effect<void, NotesProviderError> {
    return ioEffect(async (signal) => {
      const target = await this.resolveWritableNote(notePath);
      await atomicWrite(target, content, signal);
    }, `Cannot write note: ${notePath}`);
  }

  edit(
    notePath: string,
    edits: readonly ExactEdit[],
    append?: string,
  ): Effect.Effect<void, NotesProviderError> {
    return ioEffect(async (signal) => {
      const target = await this.resolveExistingNote(notePath);
      const original = await readFile(target.canonical, { encoding: "utf8", signal });
      const next = applyExactEdits(original, edits, append);
      await atomicWrite(target.canonical, next, signal);
    }, `Cannot edit note: ${notePath}`);
  }

  delete(notePath: string): Effect.Effect<void, NotesProviderError> {
    return ioEffect(async (signal) => {
      signal.throwIfAborted();
      const target = await this.resolveExistingNote(notePath);
      const metadata = await lstat(target.lexical);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        throw new NotesProviderError({
          code: "not-a-note",
          message: `Not a note file: ${notePath}`,
        });
      }
      signal.throwIfAborted();
      await unlink(target.lexical);
    }, `Cannot delete note: ${notePath}`);
  }

  queuePath(notePath: string): string {
    const normalized = normalizeNotePath(notePath);
    return path.resolve(this.root, ...normalized.split("/"));
  }

  private async resolveExistingNote(
    notePath: string,
  ): Promise<{ lexical: string; canonical: string }> {
    const normalized = normalizeNotePath(notePath);
    const lexical = path.resolve(this.root, ...normalized.split("/"));
    assertLexicallyContained(this.root, lexical, notePath);
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (cause) {
      throw new NotesProviderError({
        code: "not-found",
        message: `Note not found: ${notePath}`,
        cause,
      });
    }
    assertLexicallyContained(this.root, canonical, notePath);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
      throw new NotesProviderError({ code: "not-a-note", message: `Not a note file: ${notePath}` });
    }
    return { lexical, canonical };
  }

  private async resolveWritableNote(notePath: string): Promise<string> {
    const normalized = normalizeNotePath(notePath);
    const lexical = path.resolve(this.root, ...normalized.split("/"));
    assertLexicallyContained(this.root, lexical, notePath);

    try {
      const existing = await this.resolveExistingNote(normalized);
      return existing.canonical;
    } catch (error) {
      if (!(error instanceof NotesProviderError) || error.code !== "not-found") throw error;
    }

    const parent = path.dirname(lexical);
    const existingParent = await nearestExistingParent(parent);
    const canonicalParent = await realpath(existingParent);
    assertLexicallyContained(this.root, canonicalParent, notePath, true);
    await mkdir(parent, { recursive: true });
    const verifiedParent = await realpath(parent);
    assertLexicallyContained(this.root, verifiedParent, notePath, true);
    return path.join(verifiedParent, path.basename(lexical));
  }
}

export function applyExactEdits(
  original: string,
  edits: readonly ExactEdit[],
  append?: string,
): string {
  let next = original;
  for (const edit of edits) {
    if (edit.oldText.length === 0) {
      throw new NotesProviderError({
        code: "missing-edit",
        message: "Exact edit text must not be empty.",
      });
    }
    const first = next.indexOf(edit.oldText);
    if (first < 0) {
      throw new NotesProviderError({
        code: "missing-edit",
        message: "Exact edit text was not found.",
      });
    }
    const second = next.indexOf(edit.oldText, first + edit.oldText.length);
    if (second >= 0) {
      throw new NotesProviderError({
        code: "ambiguous-edit",
        message: "Exact edit text matched more than once.",
      });
    }
    next = `${next.slice(0, first)}${edit.newText}${next.slice(first + edit.oldText.length)}`;
  }
  return append ? next + append : next;
}

function ioEffect<A>(
  operation: (signal: AbortSignal) => Promise<A>,
  message: string,
): Effect.Effect<A, NotesProviderError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof NotesProviderError
        ? cause
        : new NotesProviderError({ code: "io", message, cause }),
  });
}

function normalizeNotePath(input: string): string {
  const stripped = input.replace(/^@/, "").replaceAll("\\", "/");
  if (
    stripped.length === 0 ||
    path.posix.isAbsolute(stripped) ||
    /^[A-Za-z]:\//.test(stripped) ||
    stripped.includes("\0")
  ) {
    throw new NotesProviderError({ code: "invalid-path", message: `Invalid note path: ${input}` });
  }
  const rawSegments = stripped.split("/");
  const normalized = path.posix.normalize(stripped);
  if (
    rawSegments.includes("..") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((part) => part.startsWith("."))
  ) {
    throw new NotesProviderError({
      code: "path-escape",
      message: `Note path escapes the vault: ${input}`,
    });
  }
  if (path.posix.extname(normalized).toLocaleLowerCase() !== MARKDOWN_EXTENSION) {
    throw new NotesProviderError({
      code: "not-a-note",
      message: `Note path must end in .md: ${input}`,
    });
  }
  return normalized;
}

function normalizePrefix(input: string): string {
  const stripped = input.replace(/^@/, "").replaceAll("\\", "/");
  if (stripped === "") return "";
  if (path.posix.isAbsolute(stripped) || stripped.includes("\0")) {
    throw new NotesProviderError({
      code: "invalid-path",
      message: `Invalid note prefix: ${input}`,
    });
  }
  const rawSegments = stripped.split("/");
  const normalized = path.posix.normalize(stripped).replace(/^\.\//, "");
  if (
    rawSegments.includes("..") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((part) => part.startsWith("."))
  ) {
    throw new NotesProviderError({
      code: "path-escape",
      message: `Note prefix escapes the vault: ${input}`,
    });
  }
  return normalized;
}

function assertLexicallyContained(
  root: string,
  candidate: string,
  source: string,
  allowRoot = false,
): void {
  const relative = path.relative(root, candidate);
  if (
    (!allowRoot && relative === "") ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new NotesProviderError({
      code: "path-escape",
      message: `Note path escapes the vault: ${source}`,
    });
  }
}

async function nearestExistingParent(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (cause) {
      if (!isMissingFileError(cause)) throw cause;
      const parent = path.dirname(current);
      if (parent === current) throw cause;
      current = parent;
    }
  }
}

async function walkMarkdownFiles(
  root: string,
  directory: string,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    signal.throwIfAborted();
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walkMarkdownFiles(root, absolute, signal)));
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== MARKDOWN_EXTENSION)
      continue;
    paths.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return paths;
}

async function atomicWrite(target: string, content: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode;
  } catch (cause) {
    if (!isMissingFileError(cause)) throw cause;
  }

  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", signal });
    if (mode !== undefined) await chmod(temp, mode);
    signal.throwIfAborted();
    await rename(temp, target);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

function formatIndex(notes: readonly NoteEntry[]): string {
  const folderCounts = new Map<string, number>();
  const entries: string[] = [];
  for (const note of notes) {
    const [first, ...rest] = note.path.split("/");
    const folder = rest.length === 0 ? "(root)" : `${first}/`;
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    if (INDEX_ENTRY_NAMES.has(path.posix.basename(note.path).toLocaleLowerCase()))
      entries.push(note.path);
  }
  const lines = [`[Notes Index]|provider:obsidian|count:${notes.length}`];
  for (const [folder, count] of [...folderCounts].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`|${folder}: ${count}`);
  }
  if (entries.length > 0)
    lines.push("|entry-notes:", ...entries.sort().map((entry) => `|- ${entry}`));
  return lines.join("\n");
}

function markdownTitle(content: string): string | undefined {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function matchingSnippet(content: string, needle: string): string | undefined {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.toLocaleLowerCase().includes(needle));
  if (!line) return undefined;
  const trimmed = line.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function isMissingFileError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}
