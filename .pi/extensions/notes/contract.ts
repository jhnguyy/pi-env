import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { DomainToolContext, ToolContract } from "../_shared/tool-contract";
import {
  MAX_APPEND_LENGTH,
  MAX_EDIT_ITEMS,
  MAX_EDIT_TEXT_LENGTH,
  MAX_INDEX_BYTES,
  MAX_INDEX_ENTRIES,
  MAX_NOTE_BYTES,
  MAX_NOTE_COUNT,
  MAX_REVISION_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
  NotesProviderError,
  type ExactEdit,
  type NoteDocument,
  type NoteEntry,
  type NoteSearchResult,
  type NotesIndex,
  type NotesMutationResult,
  type NotesProvider,
} from "./domain";

export const MAX_DETAIL_ITEMS = 200;
export const NOTES_ACTIONS = [
  "index",
  "list",
  "read",
  "search",
  "resolve",
  "write",
  "edit",
  "delete",
] as const;

export const NOTES_PARAMETERS = Type.Object(
  {
    action: StringEnum(NOTES_ACTIONS, { description: "Notes operation to perform" }),
    path: Type.Optional(
      Type.String({ maxLength: 1_024, description: "Store-relative Markdown path" }),
    ),
    prefix: Type.Optional(
      Type.String({
        maxLength: 1_024,
        description: "Optional store-relative path prefix for list",
      }),
    ),
    query: Type.Optional(
      Type.String({
        maxLength: MAX_SEARCH_QUERY_LENGTH,
        description: "Text or path query for search",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_NOTE_COUNT,
        description: `Maximum results. Search is capped at ${MAX_SEARCH_RESULTS}.`,
      }),
    ),
    reference: Type.Optional(
      Type.String({ maxLength: 256, description: "Provider-owned reference, such as daily/today" }),
    ),
    content: Type.Optional(
      Type.String({ maxLength: MAX_NOTE_BYTES, description: "Markdown content for write" }),
    ),
    revision: Type.Optional(
      Type.Union([Type.String({ maxLength: MAX_REVISION_LENGTH }), Type.Null()], {
        description:
          "Mutation precondition. Use null to require creation or the revision returned by read.",
      }),
    ),
    edits: Type.Optional(
      Type.Array(
        Type.Object({
          oldText: Type.String({
            maxLength: MAX_EDIT_TEXT_LENGTH,
            description: "Exact text that must occur once",
          }),
          newText: Type.String({
            maxLength: MAX_EDIT_TEXT_LENGTH,
            description: "Replacement text",
          }),
        }),
        { maxItems: MAX_EDIT_ITEMS, description: "Exact replacements for edit" },
      ),
    ),
    append: Type.Optional(
      Type.String({
        maxLength: MAX_APPEND_LENGTH,
        description: "Markdown text to append during edit",
      }),
    ),
  },
  { additionalProperties: false },
);

export type NotesParams = Static<typeof NOTES_PARAMETERS>;

export interface NotesToolDetails {
  readonly action: NotesParams["action"];
  readonly path?: string;
  readonly revision?: string;
  readonly notes?: readonly unknown[];
  readonly results?: readonly unknown[];
  readonly truncated?: boolean;
}

export const NOTES_DESCRIPTION = [
  "Read and mutate Markdown notes through the configured provider.",
  "Actions: index or list for discovery, read or search for retrieval, optional provider references through resolve, and guarded write, edit, or delete for mutation.",
  "Mutations require a revision precondition. Use null only to create a note.",
].join(" ");

export function createNotesContract(
  source: NotesProvider | (() => NotesProvider),
): ToolContract<NotesParams, NotesToolDetails, typeof NOTES_PARAMETERS> {
  return {
    name: "notes",
    label: "Notes",
    description: NOTES_DESCRIPTION,
    parameters: NOTES_PARAMETERS,
    execute: (params, context) =>
      executeNotesAction(typeof source === "function" ? source() : source, params, context),
  };
}

async function executeNotesAction(
  provider: NotesProvider,
  params: NotesParams,
  context: DomainToolContext,
) {
  switch (params.action) {
    case "index":
      return indexAction(provider, params, context.signal);
    case "list":
      return listAction(provider, params, context.signal);
    case "read":
      return readAction(provider, params, context.signal);
    case "search":
      return searchAction(provider, params, context.signal);
    case "resolve":
      return resolveAction(provider, params, context.signal);
    case "write":
      return writeAction(provider, params, context.signal);
    case "edit":
      return editAction(provider, params, context.signal);
    case "delete":
      return deleteAction(provider, params, context.signal);
  }
  throw new Error(`Unsupported notes action: ${String(params.action)}`);
}

async function indexAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const index = validateIndex(await provider.index(signal));
  return result(index.text, { action: params.action, notes: index.entries });
}

async function listAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const prefix = params.prefix === undefined ? undefined : normalizePrefix(params.prefix);
  const limit = params.limit ?? MAX_NOTE_COUNT;
  const entries = validateEntries(await provider.list({ prefix, limit }, signal));
  const notes = entries.slice(0, limit);
  return result(formatList(notes, prefix), {
    action: params.action,
    notes,
    ...(entries.length > limit ? { truncated: true } : {}),
  });
}

async function readAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const requestedPath = requirePath(params);
  const note = await provider.read(requestedPath, signal);
  return documentResult(params, note, requestedPath);
}

async function searchAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const query = requireSearchQuery(params);
  const limit = Math.min(params.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
  const candidates = validateSearchResults(await provider.search({ query, limit }, signal));
  const results = candidates.slice(0, limit);
  return result(formatSearch(results), {
    action: params.action,
    results,
    ...(candidates.length > limit ? { truncated: true } : {}),
  });
}

async function resolveAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  if (provider.resolve === undefined) {
    throw new NotesProviderError({
      code: "unsupported-reference",
      message: "The configured notes provider does not support references.",
    });
  }
  const note = await provider.resolve(requireReference(params), signal);
  return documentResult(params, note);
}

function documentResult(params: NotesParams, candidate: NoteDocument, expectedPath?: string) {
  const note = validateDocument(candidate, expectedPath);
  return result(formatDocument(note.path, note.revision, note.content), {
    action: params.action,
    path: note.path,
    revision: note.revision,
  });
}

async function writeAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const notePath = requirePath(params);
  if (params.content === undefined) throw new Error("notes write requires content");
  assertNoteSize(params.content);
  const mutation = validateMutation(
    await provider.write(
      {
        path: notePath,
        content: params.content,
        expectedRevision: requireWriteRevision(params),
      },
      signal,
    ),
    notePath,
  );
  return result(`Wrote ${mutation.path}`, {
    action: params.action,
    path: mutation.path,
    revision: mutation.revision,
  });
}

async function editAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const notePath = requirePath(params);
  if ((!params.edits || params.edits.length === 0) && params.append === undefined) {
    throw new Error("notes edit requires edits or append");
  }
  const revision = requireExistingRevision(params);
  const note = validateDocument(await provider.read(notePath, signal), notePath);
  if (note.revision !== revision) throw conflict(notePath);
  const mutation = validateMutation(
    await provider.write(
      {
        path: notePath,
        content: applyExactEdits(note.content, params.edits ?? [], params.append),
        expectedRevision: revision,
      },
      signal,
    ),
    notePath,
  );
  return result(`Edited ${mutation.path}`, {
    action: params.action,
    path: mutation.path,
    revision: mutation.revision,
  });
}

async function deleteAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const notePath = requirePath(params);
  const mutation = validateMutation(
    await provider.delete(
      { path: notePath, expectedRevision: requireExistingRevision(params) },
      signal,
    ),
    notePath,
  );
  return result(`Deleted ${mutation.path}`, { action: params.action, path: mutation.path });
}

export function applyExactEdits(
  original: string,
  edits: readonly ExactEdit[],
  append?: string,
): string {
  assertNoteSize(original);
  const payloadBytes = edits.reduce(
    (total, edit) => total + Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText),
    Buffer.byteLength(append ?? ""),
  );
  if (payloadBytes > MAX_NOTE_BYTES) throw noteSizeError("Exact-edit payload");
  let next = original;
  let nextBytes = Buffer.byteLength(original);
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
    const second = next.indexOf(edit.oldText, first + 1);
    if (second >= 0) {
      throw new NotesProviderError({
        code: "ambiguous-edit",
        message: "Exact edit text matched more than once.",
      });
    }
    const replacementBytes =
      nextBytes - Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText);
    if (replacementBytes > MAX_NOTE_BYTES) throw noteSizeError("Edited note");
    next = `${next.slice(0, first)}${edit.newText}${next.slice(first + edit.oldText.length)}`;
    nextBytes = replacementBytes;
  }
  if (append === undefined) return next;
  if (nextBytes + Buffer.byteLength(append) > MAX_NOTE_BYTES) throw noteSizeError("Edited note");
  return next + append;
}

function requirePath(params: NotesParams): string {
  if (!params.path) throw new Error(`notes ${params.action} requires path`);
  return normalizeStorePath(params.path, true, true);
}

function normalizePrefix(prefix: string): string {
  const stripped = (prefix.startsWith("@") ? prefix.slice(1) : prefix).replaceAll("\\", "/");
  if (stripped.startsWith("@")) {
    throw new NotesProviderError({ code: "invalid-path", message: `Invalid note path: ${prefix}` });
  }
  if (stripped === "" || stripped === "." || stripped === "./") return "";
  return normalizeStorePath(prefix, false, true);
}

function normalizeStorePath(
  input: string,
  requireMarkdown: boolean,
  allowReferencePrefix = false,
): string {
  const stripped = (
    allowReferencePrefix && input.startsWith("@") ? input.slice(1) : input
  ).replaceAll("\\", "/");
  if (isInvalidStorePath(stripped)) {
    throw new NotesProviderError({ code: "invalid-path", message: `Invalid note path: ${input}` });
  }
  const rawSegments = stripped.split("/");
  const normalized = normalizePosixPath(stripped);
  if (escapesStore(rawSegments, normalized)) {
    throw new NotesProviderError({
      code: "path-escape",
      message: `Note path escapes the store: ${input}`,
    });
  }
  if (requireMarkdown && !isMarkdownPath(stripped, normalized)) {
    throw new NotesProviderError({
      code: "not-a-note",
      message: `Note path must end in .md: ${input}`,
    });
  }
  return stripped.endsWith("/") && !normalized.endsWith("/") ? `${normalized}/` : normalized;
}

function isInvalidStorePath(input: string): boolean {
  return (
    input.length === 0 ||
    input.length > 1_024 ||
    pathIsAbsolute(input) ||
    input.startsWith("@") ||
    input.includes(":") ||
    /[\x00-\x1f\x7f]/.test(input)
  );
}

function escapesStore(rawSegments: readonly string[], normalized: string): boolean {
  return (
    rawSegments.includes("..") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => segment.startsWith("."))
  );
}

function isMarkdownPath(input: string, normalized: string): boolean {
  return !input.endsWith("/") && normalized.toLocaleLowerCase().endsWith(".md");
}

function pathIsAbsolute(input: string): boolean {
  return input.startsWith("/") || /^[A-Za-z]:\//.test(input);
}

function normalizePosixPath(input: string): string {
  const output: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") output.pop();
    else output.push(segment);
  }
  return output.join("/");
}

function requireSearchQuery(params: NotesParams): string {
  if (!params.query || params.query.trim().length === 0) {
    throw new Error("notes search requires query");
  }
  if (params.query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new NotesProviderError({
      code: "resource-limit",
      message: `Notes search query exceeds ${MAX_SEARCH_QUERY_LENGTH} characters.`,
    });
  }
  return params.query;
}

function requireReference(params: NotesParams): string {
  if (!params.reference) throw new Error("notes resolve requires reference");
  if (params.reference.length > 256 || /[\x00-\x1f\x7f]/.test(params.reference)) {
    throw new NotesProviderError({ code: "invalid-path", message: "Invalid note reference." });
  }
  return params.reference;
}

function assertNoteSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw noteSizeError("Note content");
}

function noteSizeError(subject: string): NotesProviderError {
  return new NotesProviderError({
    code: "resource-limit",
    message: `${subject} exceeds ${MAX_NOTE_BYTES} bytes.`,
  });
}

function validateDocument(note: NoteDocument, expectedPath?: string): NoteDocument {
  if (
    !isRecord(note) ||
    typeof note.path !== "string" ||
    typeof note.content !== "string" ||
    typeof note.revision !== "string"
  ) {
    throw providerContractError("Notes provider returned an invalid document.");
  }
  const path = normalizeStorePath(note.path, true);
  if (expectedPath !== undefined && path !== expectedPath) {
    throw providerContractError("Notes provider returned a document for the wrong path.");
  }
  validateRevision(note.revision);
  assertNoteSize(note.content);
  const metadata = validateOptionalMetadata(note);
  return { path, content: note.content, revision: note.revision, ...metadata };
}

function validateIndex(index: NotesIndex): NotesIndex {
  if (!isRecord(index) || typeof index.text !== "string") {
    throw providerContractError("Notes provider returned an invalid index.");
  }
  if (Buffer.byteLength(index.text) > MAX_INDEX_BYTES) {
    throw providerContractError("Notes provider returned an oversized index.");
  }
  if (
    index.entries !== undefined &&
    (!Array.isArray(index.entries) || index.entries.length > MAX_INDEX_ENTRIES)
  ) {
    throw providerContractError("Notes provider returned too many index entries.");
  }
  const entries = index.entries === undefined ? undefined : validateEntries(index.entries);
  return { text: index.text, ...(entries === undefined ? {} : { entries }) };
}

function validateEntries(entries: readonly NoteEntry[]): readonly NoteEntry[] {
  if (!Array.isArray(entries) || entries.length > MAX_NOTE_COUNT) {
    throw providerContractError("Notes provider returned too many entries.");
  }
  return entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      throw providerContractError("Notes provider returned an invalid note entry.");
    }
    const path = normalizeStorePath(entry.path, true);
    if (entry.revision !== undefined) {
      if (typeof entry.revision !== "string") {
        throw providerContractError("Notes provider returned an invalid revision.");
      }
      validateRevision(entry.revision);
    }
    const metadata = validateOptionalMetadata(entry);
    return {
      path,
      ...(entry.revision === undefined ? {} : { revision: entry.revision }),
      ...metadata,
    };
  });
}

function validateSearchResults(results: readonly NoteSearchResult[]): readonly NoteSearchResult[] {
  if (!Array.isArray(results) || results.length > MAX_SEARCH_RESULTS) {
    throw providerContractError("Notes provider returned too many search results.");
  }
  return results.map(validateSearchResult);
}

function validateSearchResult(searchResult: NoteSearchResult): NoteSearchResult {
  if (!isRecord(searchResult) || typeof searchResult.path !== "string") {
    throw providerContractError("Notes provider returned an invalid search result.");
  }
  const path = normalizeStorePath(searchResult.path, true);
  const revision = validateOptionalRevision(searchResult.revision);
  const metadata = validateOptionalMetadata(searchResult);
  const title = validateOptionalText(searchResult.title, 256, "search title");
  const snippet = validateOptionalText(searchResult.snippet, 2_048, "search snippet", true);
  const score = validateOptionalScore(searchResult.score);
  return {
    path,
    ...(revision === undefined ? {} : { revision }),
    ...metadata,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(score === undefined ? {} : { score }),
  };
}

function validateOptionalRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw providerContractError("Notes provider returned an invalid revision.");
  }
  validateRevision(value);
  return value;
}

function validateOptionalText(
  value: unknown,
  limit: number,
  label: string,
  byteLimit = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw providerContractError(`Notes provider returned an invalid ${label}.`);
  }
  const length = byteLimit ? Buffer.byteLength(value) : value.length;
  if (length > limit) throw providerContractError(`Notes provider returned an oversized ${label}.`);
  return value;
}

function validateOptionalScore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw providerContractError("Notes provider returned an invalid search score.");
  }
  return value;
}

function validateMutation(
  mutation: NotesMutationResult,
  expectedPath: string,
): NotesMutationResult {
  if (!isRecord(mutation) || typeof mutation.path !== "string") {
    throw providerContractError("Notes provider returned an invalid mutation result.");
  }
  const path = normalizeStorePath(mutation.path, true);
  if (path !== expectedPath) {
    throw providerContractError("Notes provider returned a mutation for the wrong path.");
  }
  if (mutation.revision !== undefined) {
    if (typeof mutation.revision !== "string") {
      throw providerContractError("Notes provider returned an invalid revision.");
    }
    validateRevision(mutation.revision);
  }
  return {
    path,
    ...(mutation.revision === undefined ? {} : { revision: mutation.revision }),
  };
}

function validateOptionalMetadata(
  entry: Record<string, unknown>,
): Pick<NoteEntry, "size" | "modifiedAt"> {
  if (
    entry.size !== undefined &&
    (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0)
  ) {
    throw providerContractError("Notes provider returned an invalid note size.");
  }
  if (
    entry.modifiedAt !== undefined &&
    (typeof entry.modifiedAt !== "number" || !Number.isFinite(entry.modifiedAt))
  ) {
    throw providerContractError("Notes provider returned an invalid modification time.");
  }
  return {
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt }),
  };
}

function validateRevision(revision: string, source: "provider" | "request" = "provider"): void {
  if (
    revision.length === 0 ||
    revision.length > MAX_REVISION_LENGTH ||
    /[\x00-\x1f\x7f]/.test(revision)
  ) {
    throw new NotesProviderError({
      code: source === "provider" ? "invalid-provider" : "invalid-revision",
      message: "Invalid note revision.",
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function providerContractError(message: string): NotesProviderError {
  return new NotesProviderError({ code: "invalid-provider", message });
}

function requireWriteRevision(params: NotesParams): string | null {
  if (params.revision === undefined) {
    throw new Error("notes write requires revision; use null only when creating a note");
  }
  if (params.revision !== null) validateRevision(params.revision, "request");
  return params.revision;
}

function requireExistingRevision(params: NotesParams): string {
  if (typeof params.revision !== "string") {
    throw new Error(`notes ${params.action} requires the revision returned by read`);
  }
  validateRevision(params.revision, "request");
  return params.revision;
}

function conflict(notePath: string): NotesProviderError {
  return new NotesProviderError({
    code: "conflict",
    message: `Note changed since it was read: ${notePath}`,
  });
}

function result(text: string, details: NotesToolDetails) {
  const truncated = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const boundedText = truncated.truncated
    ? `${truncated.content}\n\n[Output truncated: ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}.]`
    : truncated.content;
  const boundedDetails = boundDetails(details);
  return {
    content: [{ type: "text" as const, text: boundedText }],
    details: truncated.truncated ? { ...boundedDetails, truncated: true } : boundedDetails,
  };
}

function boundDetails(details: NotesToolDetails): NotesToolDetails {
  const notes = details.notes?.slice(0, MAX_DETAIL_ITEMS);
  const results = details.results?.slice(0, MAX_DETAIL_ITEMS);
  const truncated =
    (details.notes?.length ?? 0) > MAX_DETAIL_ITEMS ||
    (details.results?.length ?? 0) > MAX_DETAIL_ITEMS;
  return {
    ...details,
    ...(notes === undefined ? {} : { notes }),
    ...(results === undefined ? {} : { results }),
    ...(truncated ? { truncated: true } : {}),
  };
}

function formatDocument(path: string, revision: string, content: string): string {
  return `[Note path=${JSON.stringify(path)} revision=${JSON.stringify(revision)}]\n${content}`;
}

function formatList(notes: readonly NoteEntry[], prefix?: string): string {
  const header = `Found ${notes.length} note(s)${prefix ? ` under ${prefix}` : ""}:`;
  return [
    header,
    ...notes.map((note) => `- ${note.path}${note.size === undefined ? "" : ` (${note.size}B)`}`),
  ].join("\n");
}

function formatSearch(results: readonly NoteSearchResult[]): string {
  if (results.length === 0) return "No matching notes.";
  return results
    .map((searchResult, index) => {
      const title = searchResult.title ? ` — ${searchResult.title}` : "";
      const snippet = searchResult.snippet ? `\n  ${searchResult.snippet}` : "";
      return `${index + 1}. ${searchResult.path}${title}${snippet}`;
    })
    .join("\n");
}
