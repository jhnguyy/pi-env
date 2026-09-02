import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  MAX_NOTE_BYTES,
  MAX_NOTE_COUNT,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
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
const DAILY_NOTES_SETTINGS_PATH = ".obsidian/daily-notes.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_SEARCH_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_VAULT_ENTRIES = 50_000;
const MAX_DIRECTORY_DEPTH = 64;

type MutationOperation = "create" | "replace" | "delete";

export interface ObsidianProviderOptions {
  readonly now?: () => Date;
  /** Test and integration hook that runs after a read resolves its target. */
  readonly afterReadTargetResolved?: (notePath: string, target: string) => Promise<void>;
  /** Test and integration hook that runs after a mutation resolves its initial target. */
  readonly afterTargetResolved?: (
    notePath: string,
    target: string,
    operation: MutationOperation,
  ) => Promise<void>;
  /** Test and integration hook that runs immediately before the final precondition check. */
  readonly beforeCommit?: (target: string, operation: MutationOperation) => Promise<void>;
}

interface ResolvedNote {
  readonly lexical: string;
  readonly canonical: string;
  readonly device: number;
  readonly inode: number;
}

export async function createObsidianProvider(
  vaultPath: string,
  options: ObsidianProviderOptions = {},
): Promise<NotesProvider> {
  try {
    const root = await realpath(vaultPath);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new NotesProviderError({
        code: "not-a-note",
        message: `Obsidian vault is not a directory: ${vaultPath}`,
      });
    }
    return new ObsidianProvider(root, options);
  } catch (cause) {
    throw providerError(cause, `Cannot open Obsidian vault: ${vaultPath}`);
  }
}

class ObsidianProvider implements NotesProvider {
  readonly id = "obsidian";
  private readonly now: () => Date;

  constructor(
    private readonly root: string,
    private readonly options: ObsidianProviderOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

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
      const normalized = normalizeNotePath(notePath);
      const target = await this.resolveExistingNote(normalized);
      await this.options.afterReadTargetResolved?.(normalized, target.canonical);
      return await readDocument(target.canonical, normalized, signal, target);
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
    if (request.query.length > MAX_SEARCH_QUERY_LENGTH) {
      throw resourceLimit(`Notes search query exceeds ${MAX_SEARCH_QUERY_LENGTH} characters.`);
    }
    try {
      const selectedAreas = request.areas ?? [];
      const notes = await this.list({}, signal);
      const needle = request.query.toLocaleLowerCase();
      const limit = Math.min(request.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
      const results: NoteSearchResult[] = [];
      let scannedBytes = 0;
      for (const note of notes) {
        signal?.throwIfAborted();
        if (
          selectedAreas.length > 0 &&
          !selectedAreas.some((area) => note.path.startsWith(NOTES_AREA_PREFIXES[area]))
        ) {
          continue;
        }
        scannedBytes += note.size ?? MAX_NOTE_BYTES;
        if (scannedBytes > MAX_SEARCH_SCAN_BYTES) {
          throw resourceLimit(`Notes search scan exceeds ${MAX_SEARCH_SCAN_BYTES} bytes.`);
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
    const date = this.now();
    switch (reference) {
      case "daily/today":
        return this.read(await this.resolveDailyNotePath(date, signal), signal);
      case "worklog/today":
        return this.read(datedRecordPath(NOTES_AREA_PREFIXES.worklog, date), signal);
      case "decisions/today":
        return this.read(datedRecordPath(NOTES_AREA_PREFIXES.decisions, date), signal);
      default:
        throw new NotesProviderError({
          code: "unsupported-reference",
          message: `Unsupported note reference: ${reference}`,
        });
    }
  }

  async write(request: NotesWriteRequest, signal?: AbortSignal): Promise<NotesMutationResult> {
    try {
      signal?.throwIfAborted();
      assertContentSize(request.content);
      const normalized = normalizeNotePath(request.path);
      if (request.expectedRevision === null) {
        return await this.create(normalized, request.content, signal);
      }
      const expectedRevision = request.expectedRevision;
      const initial = await this.resolveExistingNote(normalized);
      await this.options.afterTargetResolved?.(normalized, initial.canonical, "replace");
      return await withFileMutationQueue(initial.canonical, async () => {
        const current = await this.resolveExistingNote(normalized);
        if (!sameTarget(current, initial)) throw conflict(normalized);
        const document = await readDocument(current.canonical, normalized, signal, current);
        if (document.revision !== expectedRevision) throw conflict(normalized);
        const mode = (await stat(current.canonical)).mode;
        await atomicReplace(current.canonical, request.content, mode, signal, async () => {
          await this.options.beforeCommit?.(current.canonical, "replace");
          await this.verifyCurrent(normalized, current, expectedRevision);
        });
        const writtenTarget = await this.resolveExistingNote(normalized);
        const written = await readDocument(
          writtenTarget.canonical,
          normalized,
          signal,
          writtenTarget,
        );
        return { path: normalized, revision: written.revision };
      });
    } catch (cause) {
      throw mutationError(cause, request.path, `Cannot write note: ${request.path}`);
    }
  }

  async delete(request: NotesDeleteRequest, signal?: AbortSignal): Promise<NotesMutationResult> {
    try {
      signal?.throwIfAborted();
      const normalized = normalizeNotePath(request.path);
      const initial = await this.resolveExistingNote(normalized);
      await this.options.afterTargetResolved?.(normalized, initial.canonical, "delete");
      return await withFileMutationQueue(initial.canonical, async () => {
        signal?.throwIfAborted();
        const current = await this.resolveExistingNote(normalized);
        if (!sameTarget(current, initial)) throw conflict(normalized);
        const document = await readDocument(current.canonical, normalized, signal, current);
        if (document.revision !== request.expectedRevision) throw conflict(normalized);
        await this.options.beforeCommit?.(current.canonical, "delete");
        await this.verifyCurrent(normalized, current, request.expectedRevision);
        signal?.throwIfAborted();
        // Standard unlink cannot combine the revision check and commit against independent writers.
        await unlink(current.canonical);
        return { path: normalized };
      });
    } catch (cause) {
      throw mutationError(cause, request.path, `Cannot delete note: ${request.path}`);
    }
  }

  private async create(
    normalized: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<NotesMutationResult> {
    signal?.throwIfAborted();
    await this.requireMissing(normalized);
    const initialTarget = await this.resolveWritableNote(normalized);
    return withFileMutationQueue(initialTarget, async () => {
      try {
        signal?.throwIfAborted();
        await this.requireMissing(normalized);
        const target = await this.resolveWritableNote(normalized);
        if (target !== initialTarget) throw conflict(normalized);
        await atomicCreate(target, content, signal, async () => {
          await this.options.beforeCommit?.(target, "create");
        });
        const writtenTarget = await this.resolveExistingNote(normalized);
        const written = await readDocument(
          writtenTarget.canonical,
          normalized,
          signal,
          writtenTarget,
        );
        return { path: normalized, revision: written.revision };
      } catch (cause) {
        if (isAlreadyExistsError(cause)) throw conflict(normalized);
        throw providerError(cause, `Cannot write note: ${normalized}`);
      }
    });
  }

  private async requireMissing(notePath: string): Promise<void> {
    try {
      await this.resolveExistingNote(notePath);
      throw conflict(notePath);
    } catch (cause) {
      if (cause instanceof NotesProviderError && cause.code === "not-found") return;
      throw cause;
    }
  }

  private async verifyCurrent(
    notePath: string,
    expectedTarget: ResolvedNote,
    expectedRevision: string,
  ): Promise<void> {
    const current = await this.resolveExistingNote(notePath);
    if (!sameTarget(current, expectedTarget)) throw conflict(notePath);
    const document = await readDocument(current.canonical, notePath, undefined, current);
    if (document.revision !== expectedRevision) throw conflict(notePath);
  }

  private async resolveDailyNotePath(date: Date, signal?: AbortSignal): Promise<string> {
    try {
      const lexical = path.join(this.root, DAILY_NOTES_SETTINGS_PATH);
      const lexicalMetadata = await lstat(lexical);
      if (lexicalMetadata.isSymbolicLink()) {
        throw new NotesProviderError({
          code: "path-escape",
          message: "Daily Notes settings must not be a symbolic link.",
        });
      }
      const canonical = await realpath(lexical);
      assertLexicallyContained(this.root, canonical, DAILY_NOTES_SETTINGS_PATH);
      const metadata = await stat(canonical);
      if (!metadata.isFile()) throw new Error("Daily Notes settings are not a regular file");
      const { content: raw } = await readBoundedText(
        canonical,
        MAX_SETTINGS_BYTES,
        "Daily Notes settings",
        signal,
      );
      const settings = JSON.parse(raw) as { folder?: unknown; format?: unknown };
      const folder =
        typeof settings.folder === "string" ? settings.folder.replace(/^\/+|\/+$/g, "") : "";
      const format =
        typeof settings.format === "string" && settings.format.length > 0
          ? settings.format
          : "YYYY-MM-DD";
      if (folder.includes("..") || folder.startsWith(".")) {
        throw new Error("Daily Notes settings contain an invalid folder");
      }
      return `${folder ? `${folder}/` : ""}${formatDailyFilename(format, date)}.md`;
    } catch (cause) {
      throw providerError(cause, "Cannot resolve Daily Notes settings");
    }
  }

  private async resolveExistingNote(notePath: string): Promise<ResolvedNote> {
    const normalized = normalizeNotePath(notePath);
    const lexical = path.resolve(this.root, ...normalized.split("/"));
    assertLexicallyContained(this.root, lexical, notePath);
    let lexicalMetadata;
    try {
      lexicalMetadata = await lstat(lexical);
    } catch (cause) {
      if (isMissingFileError(cause)) throw notFound(notePath, cause);
      throw cause;
    }
    if (lexicalMetadata.isSymbolicLink()) {
      throw new NotesProviderError({
        code: "path-escape",
        message: `Symbolic-link notes are not allowed: ${notePath}`,
      });
    }
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (cause) {
      if (isMissingFileError(cause)) throw notFound(notePath, cause);
      throw cause;
    }
    assertCanonicalNote(this.root, canonical, notePath);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
      throw new NotesProviderError({ code: "not-a-note", message: `Not a note file: ${notePath}` });
    }
    return {
      lexical,
      canonical,
      device: metadata.dev,
      inode: metadata.ino,
    };
  }

  private async resolveWritableNote(notePath: string): Promise<string> {
    const normalized = normalizeNotePath(notePath);
    const lexical = path.resolve(this.root, ...normalized.split("/"));
    assertLexicallyContained(this.root, lexical, notePath);
    const parent = path.dirname(lexical);
    const existingParent = await nearestExistingParent(parent);
    const canonicalParent = await realpath(existingParent);
    assertCanonicalParentAllowed(this.root, canonicalParent, notePath);
    await mkdir(parent, { recursive: true });
    const verifiedParent = await realpath(parent);
    assertCanonicalParentAllowed(this.root, verifiedParent, notePath);
    const target = path.join(verifiedParent, path.basename(lexical));
    assertCanonicalNote(this.root, target, notePath);
    return target;
  }
}

async function readDocument(
  target: string,
  notePath: string,
  signal?: AbortSignal,
  expectedTarget?: ResolvedNote,
): Promise<NoteDocument> {
  const { content, size, modifiedAt, device, inode } = await readBoundedText(
    target,
    MAX_NOTE_BYTES,
    `Note ${notePath}`,
    signal,
  );
  if (expectedTarget && (device !== expectedTarget.device || inode !== expectedTarget.inode)) {
    throw conflict(notePath);
  }
  return {
    path: notePath,
    content,
    revision: revisionOf(content),
    size,
    modifiedAt,
  };
}

async function readBoundedText(
  target: string,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<{
  content: string;
  size: number;
  modifiedAt: number;
  device: number;
  inode: number;
}> {
  const handle = await open(target, "r");
  try {
    const initial = await handle.stat();
    if (initial.size > maxBytes) throw resourceLimit(`${label} exceeds ${maxBytes} bytes.`);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw resourceLimit(`${label} exceeds ${maxBytes} bytes.`);
    const metadata = await handle.stat();
    return {
      content: buffer.subarray(0, total).toString("utf8"),
      size: total,
      modifiedAt: metadata.mtimeMs,
      device: metadata.dev,
      inode: metadata.ino,
    };
  } finally {
    await handle.close();
  }
}

function assertContentSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_NOTE_BYTES) {
    throw resourceLimit(`Note content exceeds ${MAX_NOTE_BYTES} bytes.`);
  }
}

function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("base64url");
}

function sameTarget(left: ResolvedNote, right: ResolvedNote): boolean {
  return (
    left.canonical === right.canonical && left.device === right.device && left.inode === right.inode
  );
}

function notFound(notePath: string, cause: unknown): NotesProviderError {
  return new NotesProviderError({
    code: "not-found",
    message: `Note not found: ${notePath}`,
    cause,
  });
}

function conflict(notePath: string): NotesProviderError {
  return new NotesProviderError({
    code: "conflict",
    message: `Note changed since it was read: ${notePath}`,
  });
}

function resourceLimit(message: string): NotesProviderError {
  return new NotesProviderError({ code: "resource-limit", message });
}

function mutationError(cause: unknown, notePath: string, message: string): unknown {
  if (cause instanceof NotesProviderError && cause.code === "not-found") {
    return conflict(notePath);
  }
  return providerError(cause, message);
}

function providerError(cause: unknown, message: string): unknown {
  if (cause instanceof NotesProviderError || isAbortError(cause)) return cause;
  return new NotesProviderError({ code: "io", message, cause });
}

function normalizeNotePath(input: string): string {
  const stripped = input.replace(/^@/, "").replaceAll("\\", "/");
  if (
    stripped.length === 0 ||
    stripped.length > 1_024 ||
    path.posix.isAbsolute(stripped) ||
    /^[A-Za-z]:\//.test(stripped) ||
    stripped.includes(":") ||
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
  if (
    stripped.length > 1_024 ||
    path.posix.isAbsolute(stripped) ||
    stripped.includes(":") ||
    stripped.includes("\0")
  ) {
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

function assertCanonicalParentAllowed(root: string, candidate: string, source: string): void {
  assertLexicallyContained(root, candidate, source, true);
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (relative && relative.split("/").some((segment) => segment.startsWith("."))) {
    throw new NotesProviderError({
      code: "path-escape",
      message: `Note parent resolves into hidden vault metadata: ${source}`,
    });
  }
}

function assertCanonicalNote(root: string, candidate: string, source: string): void {
  assertLexicallyContained(root, candidate, source);
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (relative.split("/").some((segment) => segment.startsWith("."))) {
    throw new NotesProviderError({
      code: "path-escape",
      message: `Note resolves into hidden vault metadata: ${source}`,
    });
  }
  if (path.posix.extname(relative).toLocaleLowerCase() !== MARKDOWN_EXTENSION) {
    throw new NotesProviderError({
      code: "not-a-note",
      message: `Note target must end in .md: ${source}`,
    });
  }
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

interface WalkState {
  readonly paths: string[];
  entries: number;
}

async function walkMarkdownFiles(
  root: string,
  directory: string,
  signal?: AbortSignal,
  state: WalkState = { paths: [], entries: 0 },
  depth = 0,
): Promise<string[]> {
  signal?.throwIfAborted();
  if (depth > MAX_DIRECTORY_DEPTH) {
    throw resourceLimit(`Vault directory depth exceeds ${MAX_DIRECTORY_DEPTH}.`);
  }
  const entries = [];
  for await (const entry of await opendir(directory)) {
    signal?.throwIfAborted();
    state.entries += 1;
    if (state.entries > MAX_VAULT_ENTRIES) {
      throw resourceLimit(`Vault contains more than ${MAX_VAULT_ENTRIES} entries.`);
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdownFiles(root, absolute, signal, state, depth + 1);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== MARKDOWN_EXTENSION) {
      continue;
    }
    state.paths.push(path.relative(root, absolute).split(path.sep).join("/"));
    if (state.paths.length > MAX_NOTE_COUNT) {
      throw resourceLimit(`Vault contains more than ${MAX_NOTE_COUNT} Markdown notes.`);
    }
  }
  return state.paths;
}

async function atomicCreate(
  target: string,
  content: string,
  signal: AbortSignal | undefined,
  beforeCommit: () => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  const temp = temporaryPath(target);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600, signal });
    await beforeCommit();
    signal?.throwIfAborted();
    await link(temp, target);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function atomicReplace(
  target: string,
  content: string,
  mode: number,
  signal: AbortSignal | undefined,
  beforeCommit: () => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  const temp = temporaryPath(target);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600, signal });
    await chmod(temp, mode & 0o777);
    await beforeCommit();
    signal?.throwIfAborted();
    // Standard rename cannot combine the revision check and commit against independent writers.
    await rename(temp, target);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

function temporaryPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
}

function formatDailyFilename(format: string, date: Date): string {
  const counts = { YYYY: 0, MM: 0, DD: 0 };
  for (let offset = 0; offset < format.length;) {
    const token = (["YYYY", "MM", "DD"] as const).find((candidate) =>
      format.startsWith(candidate, offset),
    );
    if (token) {
      counts[token] += 1;
      offset += token.length;
      continue;
    }
    if (!"/_.-".includes(format[offset] ?? "")) throw unsupportedDailyFormat(format);
    offset += 1;
  }
  if (counts.YYYY !== 1 || counts.MM !== 1 || counts.DD !== 1) {
    throw unsupportedDailyFormat(format);
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return format.replace("YYYY", year).replace("MM", month).replace("DD", day);
}

function unsupportedDailyFormat(format: string): NotesProviderError {
  return new NotesProviderError({
    code: "invalid-path",
    message: `Unsupported Daily Notes format: ${format}`,
  });
}

function datedRecordPath(prefix: string, date: Date): string {
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

function isAlreadyExistsError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError"
  );
}
