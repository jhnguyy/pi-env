import { createHash, randomUUID } from "node:crypto";
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
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  NOTES_AREA_PREFIXES,
  NotesProviderError,
  type NoteDocument,
  type NoteEntry,
  type NoteSearchResult,
  type NotesDeleteRequest,
  type NotesListRequest,
  type NotesMutationResult,
  type NotesProvider,
  type NotesSearchRequest,
  type NotesWriteRequest,
} from "./domain";

const MARKDOWN_EXTENSION = ".md";
const MAX_SEARCH_RESULTS = 100;
const DAILY_NOTES_SETTINGS_PATH = ".obsidian/daily-notes.json";

export async function createObsidianProvider(vaultPath: string): Promise<NotesProvider> {
  try {
    const root = await realpath(vaultPath);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new NotesProviderError({
        code: "not-a-note",
        message: `Obsidian vault is not a directory: ${vaultPath}`,
      });
    }
    return new ObsidianProvider(root);
  } catch (cause) {
    throw providerError(cause, `Cannot open Obsidian vault: ${vaultPath}`);
  }
}

class ObsidianProvider implements NotesProvider {
  readonly id = "obsidian";

  constructor(private readonly root: string) {}

  async list(request: NotesListRequest, signal?: AbortSignal): Promise<readonly NoteEntry[]> {
    try {
      signal?.throwIfAborted();
      const areaPrefix = request.area === undefined ? undefined : NOTES_AREA_PREFIXES[request.area];
      const explicitPrefix =
        request.prefix === undefined ? undefined : normalizePrefix(request.prefix);
      const paths = await walkMarkdownFiles(this.root, this.root, signal);
      const entries: NoteEntry[] = [];
      for (const notePath of paths) {
        signal?.throwIfAborted();
        if (areaPrefix && !notePath.startsWith(areaPrefix)) continue;
        if (explicitPrefix && !notePath.startsWith(explicitPrefix)) continue;
        const metadata = await stat(path.join(this.root, ...notePath.split("/")));
        entries.push({ path: notePath, size: metadata.size, modifiedAt: metadata.mtimeMs });
      }
      return entries.sort((left, right) => left.path.localeCompare(right.path));
    } catch (cause) {
      throw providerError(cause, "Cannot list Obsidian notes");
    }
  }

  async read(notePath: string, signal?: AbortSignal): Promise<NoteDocument> {
    try {
      signal?.throwIfAborted();
      const target = await this.resolveExistingNote(notePath);
      return await readDocument(target.canonical, normalizeNotePath(notePath), signal);
    } catch (cause) {
      throw providerError(cause, `Cannot read note: ${notePath}`);
    }
  }

  async search(
    request: NotesSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly NoteSearchResult[]> {
    if (request.query.trim().length === 0) {
      throw new NotesProviderError({
        code: "invalid-path",
        message: "Notes search requires a non-empty query.",
      });
    }
    try {
      const selectedAreas = request.areas ?? [];
      const notes = await this.list({}, signal);
      const needle = request.query.toLocaleLowerCase();
      const limit = Math.min(request.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
      const results: NoteSearchResult[] = [];
      for (const note of notes) {
        signal?.throwIfAborted();
        if (
          selectedAreas.length > 0 &&
          !selectedAreas.some((area) => note.path.startsWith(NOTES_AREA_PREFIXES[area]))
        ) {
          continue;
        }
        const document = await this.read(note.path, signal);
        const pathMatch = note.path.toLocaleLowerCase().includes(needle);
        const contentMatch = document.content.toLocaleLowerCase().includes(needle);
        if (!pathMatch && !contentMatch) continue;
        results.push({
          path: note.path,
          revision: document.revision,
          size: document.size,
          modifiedAt: document.modifiedAt,
          title: markdownTitle(document.content),
          snippet: matchingSnippet(document.content, needle),
        });
        if (results.length >= limit) break;
      }
      return results;
    } catch (cause) {
      throw providerError(cause, `Cannot search notes for: ${request.query}`);
    }
  }

  async resolve(reference: string, signal?: AbortSignal): Promise<NoteDocument> {
    switch (reference) {
      case "daily/today":
        return this.read(await this.resolveDailyNotePath(signal), signal);
      case "worklog/today":
        return this.read(datedRecordPath(NOTES_AREA_PREFIXES.worklog), signal);
      case "decisions/today":
        return this.read(datedRecordPath(NOTES_AREA_PREFIXES.decisions), signal);
      default:
        throw new NotesProviderError({
          code: "unsupported-reference",
          message: `Unsupported note reference: ${reference}`,
        });
    }
  }

  async write(request: NotesWriteRequest, signal?: AbortSignal): Promise<NotesMutationResult> {
    const normalized = normalizeNotePath(request.path);
    const queuePath = path.resolve(this.root, ...normalized.split("/"));
    return withFileMutationQueue(queuePath, async () => {
      try {
        signal?.throwIfAborted();
        let target: string;
        if (request.expectedRevision === null) {
          try {
            await this.resolveExistingNote(normalized);
            throw conflict(normalized);
          } catch (cause) {
            if (!(cause instanceof NotesProviderError) || cause.code !== "not-found") throw cause;
          }
          target = await this.resolveWritableNote(normalized);
        } else {
          const existing = await this.resolveExistingNote(normalized);
          const current = await readDocument(existing.canonical, normalized, signal);
          if (current.revision !== request.expectedRevision) throw conflict(normalized);
          target = existing.canonical;
        }
        await atomicWrite(target, request.content, signal);
        const written = await readDocument(target, normalized, signal);
        return { path: normalized, revision: written.revision };
      } catch (cause) {
        throw providerError(cause, `Cannot write note: ${request.path}`);
      }
    });
  }

  async delete(request: NotesDeleteRequest, signal?: AbortSignal): Promise<NotesMutationResult> {
    const normalized = normalizeNotePath(request.path);
    const queuePath = path.resolve(this.root, ...normalized.split("/"));
    return withFileMutationQueue(queuePath, async () => {
      try {
        signal?.throwIfAborted();
        const target = await this.resolveExistingNote(normalized);
        const current = await readDocument(target.canonical, normalized, signal);
        if (current.revision !== request.expectedRevision) throw conflict(normalized);
        const metadata = await lstat(target.lexical);
        if (!metadata.isFile() && !metadata.isSymbolicLink()) {
          throw new NotesProviderError({
            code: "not-a-note",
            message: `Not a note file: ${request.path}`,
          });
        }
        signal?.throwIfAborted();
        await unlink(target.lexical);
        return { path: normalized };
      } catch (cause) {
        throw providerError(cause, `Cannot delete note: ${request.path}`);
      }
    });
  }

  private async resolveDailyNotePath(signal?: AbortSignal): Promise<string> {
    try {
      const settingsPath = path.join(this.root, DAILY_NOTES_SETTINGS_PATH);
      const settings = JSON.parse(await readFile(settingsPath, { encoding: "utf8", signal })) as {
        folder?: unknown;
        format?: unknown;
      };
      const folder =
        typeof settings.folder === "string" ? settings.folder.replace(/^\/+|\/+$/g, "") : "";
      const format =
        typeof settings.format === "string" && settings.format.length > 0
          ? settings.format
          : "YYYY-MM-DD";
      if (folder.includes("..") || folder.startsWith(".")) {
        throw new Error("Daily Notes settings contain an invalid folder");
      }
      if (!/^[YMD/_.-]+$/.test(format)) {
        throw new Error(`Unsupported Daily Notes format: ${format}`);
      }
      const date = new Date();
      const year = String(date.getFullYear()).padStart(4, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const filename = format
        .replaceAll("YYYY", year)
        .replaceAll("MM", month)
        .replaceAll("DD", day);
      if (/[YMD]/.test(filename)) throw new Error(`Unsupported Daily Notes format: ${format}`);
      return `${folder ? `${folder}/` : ""}${filename}.md`;
    } catch (cause) {
      throw providerError(cause, "Cannot resolve Daily Notes settings");
    }
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

async function readDocument(
  target: string,
  notePath: string,
  signal?: AbortSignal,
): Promise<NoteDocument> {
  const content = await readFile(target, { encoding: "utf8", signal });
  const metadata = await stat(target);
  return {
    path: notePath,
    content,
    revision: revisionOf(content),
    size: metadata.size,
    modifiedAt: metadata.mtimeMs,
  };
}

function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("base64url");
}

function conflict(notePath: string): NotesProviderError {
  return new NotesProviderError({
    code: "conflict",
    message: `Note changed since it was read: ${notePath}`,
  });
}

function providerError(cause: unknown, message: string): unknown {
  if (cause instanceof NotesProviderError || isAbortError(cause)) return cause;
  return new NotesProviderError({ code: "io", message, cause });
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
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    signal?.throwIfAborted();
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walkMarkdownFiles(root, absolute, signal)));
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== MARKDOWN_EXTENSION) {
      continue;
    }
    paths.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return paths;
}

async function atomicWrite(target: string, content: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    await rename(temp, target);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

function datedRecordPath(prefix: string, date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${prefix}${year}/${month}/${day}.md`;
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

function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError"
  );
}
