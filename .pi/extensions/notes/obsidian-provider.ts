import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  chown,
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
  MAX_INDEX_ENTRIES,
  MAX_NOTE_BYTES,
  MAX_NOTE_COUNT,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
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
const MAX_SEARCH_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_VAULT_ENTRIES = 50_000;
const MAX_DIRECTORY_DEPTH = 64;

type MutationOperation = "create" | "replace" | "delete";

export interface ObsidianProviderOptions {
  /** Test and integration hook that runs after a read resolves its target. */
  readonly afterReadTargetResolved?: (notePath: string, target: string) => Promise<void>;
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

  constructor(
    private readonly root: string,
    private readonly options: ObsidianProviderOptions,
  ) {}

  async index(signal?: AbortSignal) {
    const notes = await this.list({}, signal);
    return {
      text: formatObsidianIndex(notes),
      entries: notes.slice(0, MAX_INDEX_ENTRIES),
    };
  }

  async list(request: NotesListRequest, signal?: AbortSignal): Promise<readonly NoteEntry[]> {
    try {
      signal?.throwIfAborted();
      const explicitPrefix =
        request.prefix === undefined ? undefined : normalizePrefix(request.prefix);
      const limit = Math.min(request.limit ?? MAX_NOTE_COUNT, MAX_NOTE_COUNT);
      const paths = await walkMarkdownFiles(this.root, this.root, signal);
      const entries: NoteEntry[] = [];
      for (const notePath of paths) {
        signal?.throwIfAborted();
        if (explicitPrefix && !notePath.startsWith(explicitPrefix)) continue;
        const metadata = await lstat(path.join(this.root, ...notePath.split("/")));
        if (!metadata.isFile() || metadata.nlink !== 1) continue;
        entries.push({ path: notePath, size: metadata.size, modifiedAt: metadata.mtimeMs });
      }
      return entries.sort((left, right) => left.path.localeCompare(right.path)).slice(0, limit);
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
      const notes = await this.list({}, signal);
      const needle = request.query.toLocaleLowerCase();
      const limit = Math.min(request.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
      const results: NoteSearchResult[] = [];
      let scannedBytes = 0;
      for (const note of notes) {
        signal?.throwIfAborted();
        const estimatedBytes = note.size ?? MAX_NOTE_BYTES;
        if (scannedBytes + estimatedBytes > MAX_SEARCH_SCAN_BYTES) {
          throw resourceLimit(`Notes search scan exceeds ${MAX_SEARCH_SCAN_BYTES} bytes.`);
        }
        const document = await this.read(note.path, signal);
        scannedBytes += document.size ?? Buffer.byteLength(document.content);
        if (scannedBytes > MAX_SEARCH_SCAN_BYTES) {
          throw resourceLimit(`Notes search scan exceeds ${MAX_SEARCH_SCAN_BYTES} bytes.`);
        }
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
      return await withFileMutationQueue(initial.canonical, async () => {
        const current = await this.resolveExistingNote(normalized);
        if (!sameTarget(current, initial)) throw conflict(normalized);
        const document = await readDocument(current.canonical, normalized, signal, current);
        if (document.revision !== expectedRevision) throw conflict(normalized);
        const metadata = await stat(current.canonical);
        await atomicReplace(current.canonical, request.content, metadata, signal, async () => {
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

  private async resolveExistingNote(notePath: string): Promise<ResolvedNote> {
    const normalized = normalizeNotePath(notePath);
    const lexical = path.resolve(this.root, ...normalized.split("/"));
    assertLexicallyContained(this.root, lexical, notePath);
    let lexicalMetadata;
    try {
      await assertNoSymlinkPath(this.root, lexical, notePath, false);
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
    if (lexicalMetadata.nlink !== 1) {
      throw new NotesProviderError({
        code: "path-escape",
        message: `Hard-linked notes are not allowed: ${notePath}`,
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
    await assertNoSymlinkPath(this.root, parent, notePath, true);
    const existingParent = await nearestExistingParent(parent);
    const canonicalParent = await realpath(existingParent);
    assertCanonicalParentAllowed(this.root, canonicalParent, notePath);
    await mkdir(parent, { recursive: true });
    await assertNoSymlinkPath(this.root, parent, notePath, false);
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
  const { content, contentDigest, size, modifiedAt, changedAt, device, inode, mode, owner, group } =
    await readBoundedText(
      target,
      MAX_NOTE_BYTES,
      `Note ${notePath}`,
      signal,
      expectedTarget,
      notePath,
    );
  return {
    path: notePath,
    content,
    revision: revisionOf({
      contentDigest,
      notePath,
      device,
      inode,
      mode,
      owner,
      group,
      changedAt,
    }),
    size,
    modifiedAt,
  };
}

async function readBoundedText(
  target: string,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
  expectedTarget?: ResolvedNote,
  identityPath = label,
): Promise<{
  content: string;
  contentDigest: string;
  size: number;
  modifiedAt: number;
  device: number;
  inode: number;
  mode: number;
  owner: number;
  group: number;
  changedAt: number;
}> {
  const handle = await open(target, "r");
  try {
    const initial = await handle.stat();
    if (
      expectedTarget &&
      (initial.dev !== expectedTarget.device || initial.ino !== expectedTarget.inode)
    ) {
      throw conflict(identityPath);
    }
    if (initial.size > maxBytes) throw resourceLimit(`${label} exceeds ${maxBytes} bytes.`);
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, initial.size + 1));
    let total = 0;
    while (total < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > initial.size) throw conflict(identityPath);
    const metadata = await handle.stat();
    if (
      metadata.dev !== initial.dev ||
      metadata.ino !== initial.ino ||
      metadata.size !== initial.size ||
      metadata.mtimeMs !== initial.mtimeMs ||
      metadata.ctimeMs !== initial.ctimeMs
    ) {
      throw conflict(identityPath);
    }
    const bytes = buffer.subarray(0, total);
    return {
      content: bytes.toString("utf8"),
      contentDigest: createHash("sha256").update(bytes).digest("base64url"),
      size: total,
      modifiedAt: metadata.mtimeMs,
      changedAt: metadata.ctimeMs,
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode,
      owner: metadata.uid,
      group: metadata.gid,
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

function revisionOf(input: {
  contentDigest: string;
  notePath: string;
  device: number;
  inode: number;
  mode: number;
  owner: number;
  group: number;
  changedAt: number;
}): string {
  return createHash("sha256")
    .update(
      `${input.notePath}\0${input.device}\0${input.inode}\0${input.mode}\0${input.owner}\0${input.group}\0${input.changedAt}\0${input.contentDigest}`,
    )
    .digest("base64url");
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
  const stripped = input.replaceAll("\\", "/");
  if (
    stripped.length === 0 ||
    stripped.length > 1_024 ||
    path.posix.isAbsolute(stripped) ||
    /^[A-Za-z]:\//.test(stripped) ||
    stripped.startsWith("@") ||
    stripped.includes(":") ||
    /[\x00-\x1f\x7f]/.test(stripped)
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
  const stripped = input.replaceAll("\\", "/");
  if (stripped === "") return "";
  if (
    stripped.length > 1_024 ||
    path.posix.isAbsolute(stripped) ||
    stripped.startsWith("@") ||
    stripped.includes(":") ||
    /[\x00-\x1f\x7f]/.test(stripped)
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

async function assertNoSymlinkPath(
  root: string,
  candidate: string,
  source: string,
  allowMissing: boolean,
): Promise<void> {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (cause) {
      if (allowMissing && isMissingFileError(cause)) return;
      throw cause;
    }
    if (metadata.isSymbolicLink()) {
      throw new NotesProviderError({
        code: "path-escape",
        message: `Symbolic-link path segments are not allowed: ${source}`,
      });
    }
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
    const notePath = path.relative(root, absolute).split(path.sep).join("/");
    if (!isPortableNotePath(notePath)) continue;
    state.paths.push(notePath);
    if (state.paths.length > MAX_NOTE_COUNT) {
      throw resourceLimit(`Vault contains more than ${MAX_NOTE_COUNT} Markdown notes.`);
    }
  }
  return state.paths;
}

function isPortableNotePath(notePath: string): boolean {
  try {
    return normalizeNotePath(notePath) === notePath;
  } catch {
    return false;
  }
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
  metadata: { mode: number; uid: number; gid: number },
  signal: AbortSignal | undefined,
  beforeCommit: () => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  const temp = temporaryPath(target);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600, signal });
    if (process.platform !== "win32") {
      await chown(temp, metadata.uid, metadata.gid);
      await chmod(temp, metadata.mode & 0o7777);
    }
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

function formatObsidianIndex(notes: readonly NoteEntry[]): string {
  const rootCounts = new Map<string, number>();
  for (const note of notes) {
    const root = note.path.includes("/") ? (note.path.split("/", 1)[0] ?? "(root)") : "(root)";
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  }
  const roots = [...rootCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 100)
    .map(([root, count]) => `${root.slice(0, 64)}(${count})`)
    .join(",");
  return [
    `[Notes Index]|provider:obsidian|count:${notes.length}`,
    "|Markdown files only. Hidden directories and Obsidian metadata are excluded.",
    "|Use list with a prefix for authoritative inventory. Read nearby notes before choosing a destination.",
    `|roots:${roots || "(empty)"}`,
  ].join("\n");
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
