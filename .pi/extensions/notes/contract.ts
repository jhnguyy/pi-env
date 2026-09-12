import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DomainToolContext, ToolContract } from "../_shared/tool-contract";
import {
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
  MAX_COLLECTION_RESULT_BYTES,
  appendSectionItem,
  decodeCursor,
  encodeCursor,
  extractInboxItems,
  extractWorklogItems,
  inboxDateFromPath,
  inboxPath,
  localDate,
  newInboxNote,
  newWorklogRecord,
  page,
  recordDateFromPath,
  recordPath,
  requireIsoDate,
  wikiChildren,
  wikiTarget,
  worklogSelection,
  type InboxItemKind,
  type WorklogItem,
} from "./collection-policy";
import {
  MAX_APPEND_LENGTH,
  MAX_EDIT_ITEMS,
  MAX_EDIT_TEXT_LENGTH,
  MAX_INDEX_BYTES,
  MAX_INDEX_ENTRIES,
  MAX_LIST_CURSOR_LENGTH,
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
  type NotesListResult,
  type NotesMutationResult,
  type NotesProvider,
} from "./domain";

export const MAX_DETAIL_ITEMS = 200;
const MAX_COLLECTION_DOCUMENTS_PER_READ = 32;
const MAX_PROVIDER_LIST_PAGES = 100;
export const NOTES_ACTIONS = [
  "index",
  "list",
  "read",
  "search",
  "resolve",
  "write",
  "edit",
  "delete",
  "record",
] as const;

export const NOTES_COLLECTIONS = ["store", "inbox", "worklog", "wiki"] as const;
const NOTES_STORE_ACTIONS = NOTES_ACTIONS.filter((action) => action !== "record");

const collectionLimitParameter = () =>
  Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_COLLECTION_LIMIT,
      description: "Maximum collection results",
    }),
  );
const continuationCursor = () =>
  Type.Optional(
    Type.String({
      maxLength: MAX_LIST_CURSOR_LENGTH,
      description: "Opaque continuation cursor returned by the same read",
    }),
  );
const revisionPrecondition = () =>
  Type.Union([Type.String({ maxLength: MAX_REVISION_LENGTH }), Type.Null()], {
    description: "Use null to require creation or the revision returned by read for update.",
  });

export const NOTES_PARAMETERS = Type.Union([
  Type.Object(
    {
      collection: Type.Optional(Type.Literal("store")),
      action: StringEnum(NOTES_STORE_ACTIONS, { description: "Transitional Store operation" }),
      path: Type.Optional(
        Type.String({ maxLength: 1_024, description: "Store-relative Markdown path" }),
      ),
      prefix: Type.Optional(
        Type.String({ maxLength: 1_024, description: "Store-relative list prefix" }),
      ),
      query: Type.Optional(
        Type.String({ maxLength: MAX_SEARCH_QUERY_LENGTH, description: "Search query" }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_DETAIL_ITEMS,
          description: `Maximum Store list results. Search is capped at ${MAX_SEARCH_RESULTS}.`,
        }),
      ),
      cursor: Type.Optional(
        Type.String({ maxLength: MAX_LIST_CURSOR_LENGTH, description: "Store list cursor" }),
      ),
      reference: Type.Optional(
        Type.String({ maxLength: 256, description: "Provider-owned reference" }),
      ),
      content: Type.Optional(Type.String({ maxLength: MAX_NOTE_BYTES })),
      revision: Type.Optional(revisionPrecondition()),
      edits: Type.Optional(
        Type.Array(
          Type.Object({
            oldText: Type.String({ maxLength: MAX_EDIT_TEXT_LENGTH }),
            newText: Type.String({ maxLength: MAX_EDIT_TEXT_LENGTH }),
          }),
          { maxItems: MAX_EDIT_ITEMS },
        ),
      ),
      append: Type.Optional(Type.String({ maxLength: MAX_APPEND_LENGTH })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      collection: Type.Literal("inbox"),
      action: Type.Literal("read"),
      date: Type.Optional(Type.String({ maxLength: 10, description: "Exact ISO date" })),
      limit: collectionLimitParameter(),
      cursor: continuationCursor(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      collection: Type.Literal("inbox"),
      action: Type.Literal("write"),
      kind: StringEnum(["note", "followup"] as const),
      text: Type.String({ maxLength: MAX_APPEND_LENGTH }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      collection: Type.Literal("worklog"),
      action: Type.Literal("read"),
      selector: Type.Optional(
        Type.String({ maxLength: 32, description: "ISO date, inclusive range, or all" }),
      ),
      order: Type.Optional(StringEnum(["newest", "chronological"] as const)),
      limit: collectionLimitParameter(),
      cursor: continuationCursor(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      collection: Type.Literal("worklog"),
      action: Type.Literal("record"),
      text: Type.String({ maxLength: MAX_APPEND_LENGTH }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      collection: Type.Literal("wiki"),
      action: Type.Literal("read"),
      target: Type.Optional(
        Type.String({ maxLength: 1_018, description: "Path relative to wiki/" }),
      ),
      limit: collectionLimitParameter(),
      cursor: continuationCursor(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      collection: Type.Literal("wiki"),
      action: Type.Literal("write"),
      target: Type.String({ maxLength: 1_018, description: "Markdown path relative to wiki/" }),
      content: Type.String({ maxLength: MAX_NOTE_BYTES }),
      revision: revisionPrecondition(),
    },
    { additionalProperties: false },
  ),
]);

export interface NotesParams {
  readonly collection?: (typeof NOTES_COLLECTIONS)[number];
  readonly action: (typeof NOTES_ACTIONS)[number];
  readonly kind?: InboxItemKind;
  readonly date?: string;
  readonly selector?: string;
  readonly order?: "newest" | "chronological";
  readonly cursor?: string;
  readonly target?: string;
  readonly text?: string;
  readonly path?: string;
  readonly prefix?: string;
  readonly query?: string;
  readonly limit?: number;
  readonly reference?: string;
  readonly content?: string;
  readonly revision?: string | null;
  readonly edits?: readonly ExactEdit[];
  readonly append?: string;
}

export interface NotesToolDetails {
  readonly action: NotesParams["action"];
  readonly collection?: (typeof NOTES_COLLECTIONS)[number];
  readonly path?: string;
  readonly revision?: string;
  readonly notes?: readonly unknown[];
  readonly results?: readonly unknown[];
  readonly items?: readonly unknown[];
  readonly nextCursor?: string;
  readonly truncated?: boolean;
}

export interface NotesContractOptions {
  readonly now?: () => Date;
}

export const NOTES_DESCRIPTION = [
  "Read and maintain Inbox, Worklog, Wiki, and transitional Store notes through the configured provider.",
  "Use collection-specific actions for core note behavior and Store actions for orientation, search, legacy access, and maintenance.",
  "Reads are bounded and non-destructive. Mutations preserve unrelated content and use revision preconditions.",
].join(" ");

export function createNotesContract(
  source: NotesProvider | (() => NotesProvider),
  options: NotesContractOptions = {},
): ToolContract<NotesParams, NotesToolDetails, typeof NOTES_PARAMETERS> {
  const now = options.now ?? (() => new Date());
  return {
    name: "notes",
    label: "Notes",
    description: NOTES_DESCRIPTION,
    parameters: NOTES_PARAMETERS,
    execute: (params, context) =>
      executeNotesAction(typeof source === "function" ? source() : source, params, context, now),
  };
}

async function executeNotesAction(
  provider: NotesProvider,
  params: NotesParams,
  context: DomainToolContext,
  now: () => Date,
) {
  const collection = params.collection ?? "store";
  if (collection !== "store") {
    return executeCollectionAction(provider, collection, params, context.signal, now);
  }
  if (params.action === "record") throw invalidCollectionAction(collection, params.action);
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

async function executeCollectionAction(
  provider: NotesProvider,
  collection: "inbox" | "worklog" | "wiki",
  params: NotesParams,
  signal: AbortSignal | undefined,
  now: () => Date,
) {
  switch (collection) {
    case "inbox":
      if (params.action === "read") return inboxReadAction(provider, params, signal);
      if (params.action === "write") return inboxWriteAction(provider, params, signal, now);
      break;
    case "worklog":
      if (params.action === "read") return worklogReadAction(provider, params, signal, now);
      if (params.action === "record") return worklogRecordAction(provider, params, signal, now);
      break;
    case "wiki":
      if (params.action === "read") return wikiReadAction(provider, params, signal);
      if (params.action === "write") return wikiWriteAction(provider, params, signal);
      break;
  }
  throw invalidCollectionAction(collection, params.action);
}

async function inboxReadAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const exactDate = params.date === undefined ? undefined : requireIsoDate(params.date);
  if (exactDate !== undefined) return datedInboxRead(provider, params, exactDate, signal);
  return earliestInboxRead(provider, params, signal);
}

async function datedInboxRead(
  provider: NotesProvider,
  params: NotesParams,
  date: string,
  signal?: AbortSignal,
) {
  const cursor = decodeCursor(params.cursor, "inbox", date);
  const path = inboxPath(date);
  const note = await readOptionalDocument(provider, path, signal);
  const items = note === undefined ? [] : extractInboxItems(note.content, date, path);
  const envelope = page(items, collectionLimit(params.limit), cursor.offset, (next) =>
    encodeCursor("inbox", date, next),
  );
  return inboxResult(params, envelope);
}

async function earliestInboxRead(
  provider: NotesProvider,
  params: NotesParams,
  signal?: AbortSignal,
) {
  const scope = "earliest";
  const cursor = decodeCursor(params.cursor, "inbox", scope);
  const paths = await canonicalPaths(
    provider,
    "inbox/",
    inboxDateFromPath,
    "chronological",
    signal,
  );
  let started = cursor.location === undefined;
  let scanned = 0;
  for (const path of paths) {
    if (!started) {
      started = path === cursor.location;
      if (!started) continue;
    }
    if (scanned === MAX_COLLECTION_DOCUMENTS_PER_READ) {
      return inboxResult(params, {
        items: [],
        nextCursor: encodeCursor("inbox", scope, 0, path),
      });
    }
    scanned += 1;
    const item = await earliestItemFromPath(provider, path, cursor, signal);
    if (item !== undefined) {
      return inboxResult(
        params,
        page([item], 1, 0, (next) => encodeCursor("inbox", scope, next, path)),
      );
    }
  }
  if (!started && cursor.location !== undefined) throw invalidCollectionCursor();
  return inboxResult(params, { items: [] });
}

async function earliestItemFromPath(
  provider: NotesProvider,
  path: string,
  cursor: { readonly location?: string; readonly offset: number },
  signal?: AbortSignal,
) {
  const date = inboxDateFromPath(path);
  if (date === undefined) return undefined;
  const note = await readOptionalDocument(provider, path, signal);
  if (note === undefined) return undefined;
  const items = extractInboxItems(note.content, date, path);
  return items[path === cursor.location ? cursor.offset : 0];
}

function inboxResult(
  params: NotesParams,
  envelope: { readonly items: readonly unknown[]; readonly nextCursor?: string },
) {
  return collectionResult(collectionText("Inbox", envelope), {
    action: params.action,
    collection: "inbox",
    items: envelope.items,
    nextCursor: envelope.nextCursor,
  });
}

async function inboxWriteAction(
  provider: NotesProvider,
  params: NotesParams,
  signal: AbortSignal | undefined,
  now: () => Date,
) {
  const kind = requireInboxKind(params.kind);
  const text = requireItemText(params.text, "Inbox write");
  const date = localDate(now());
  const path = inboxPath(date);
  const current = await readOptionalDocument(provider, path, signal);
  const content = current
    ? appendSectionItem(current.content, kind === "followup" ? "Follow-ups" : "Notes", text)
    : newInboxNote(kind, text);
  assertNoteSize(content);
  const mutation = validateMutation(
    await provider.write({ path, content, expectedRevision: current?.revision ?? null }, signal),
    path,
  );
  return result(`Recorded Inbox ${kind} in ${path}`, {
    action: params.action,
    collection: "inbox",
    path,
    revision: mutation.revision,
  });
}

async function worklogReadAction(
  provider: NotesProvider,
  params: NotesParams,
  signal: AbortSignal | undefined,
  now: () => Date,
) {
  const today = localDate(now());
  const selection = worklogSelection(params.selector, today);
  const order = params.order ?? "newest";
  const paths =
    selection.scope === today || /^\d{4}-\d{2}-\d{2}$/.test(selection.scope)
      ? [recordPath(selection.scope)]
      : await canonicalPaths(provider, "records/", recordDateFromPath, order, signal);
  const selectedPaths = paths.filter((path) => {
    const date = recordDateFromPath(path);
    return date !== undefined && selection.matches(date);
  });
  const scope = `${selection.scope}:${order}`;
  const cursor = decodeCursor(params.cursor, "worklog", scope);
  const envelope = await collectWorklogPage(
    provider,
    selectedPaths,
    cursor,
    scope,
    collectionLimit(params.limit),
    signal,
  );
  return collectionResult(collectionText("Worklog", envelope), {
    action: params.action,
    collection: "worklog",
    items: envelope.items,
    nextCursor: envelope.nextCursor,
  });
}

async function collectWorklogPage(
  provider: NotesProvider,
  paths: readonly string[],
  cursor: { readonly location?: string; readonly offset: number },
  scope: string,
  limit: number,
  signal?: AbortSignal,
) {
  const items: WorklogItem[] = [];
  let itemBytes = 0;
  let nextCursor: string | undefined;
  let scanned = 0;
  let started = cursor.location === undefined;
  for (const path of paths) {
    if (!started) {
      started = path === cursor.location;
      if (!started) continue;
    }
    if (scanned === MAX_COLLECTION_DOCUMENTS_PER_READ) {
      nextCursor = encodeCursor("worklog", scope, 0, path);
      break;
    }
    scanned += 1;
    const pathItems = await worklogItemsFromPath(provider, path, signal);
    const start = path === cursor.location ? cursor.offset : 0;
    const batch = takeWorklogItems(
      pathItems,
      start,
      limit - items.length,
      MAX_COLLECTION_RESULT_BYTES - itemBytes,
    );
    items.push(...batch.items);
    itemBytes += batch.bytes;
    if (batch.nextIndex !== undefined) {
      nextCursor = encodeCursor("worklog", scope, batch.nextIndex, path);
      break;
    }
  }
  if (!started && cursor.location !== undefined) throw invalidCollectionCursor();
  return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

async function worklogItemsFromPath(
  provider: NotesProvider,
  path: string,
  signal?: AbortSignal,
): Promise<WorklogItem[]> {
  const date = recordDateFromPath(path);
  if (date === undefined) return [];
  const note = await readOptionalDocument(provider, path, signal);
  return note === undefined ? [] : extractWorklogItems(note.content, date, path);
}

function takeWorklogItems(
  values: readonly WorklogItem[],
  start: number,
  limit: number,
  byteLimit: number,
): { readonly items: WorklogItem[]; readonly bytes: number; readonly nextIndex?: number } {
  const items: WorklogItem[] = [];
  let bytes = 0;
  for (let index = start; index < values.length; index += 1) {
    const valueBytes = Buffer.byteLength(JSON.stringify(values[index]));
    if (valueBytes > MAX_COLLECTION_RESULT_BYTES) {
      throw new NotesProviderError({
        code: "resource-limit",
        message: "One Worklog item exceeds the result byte limit.",
      });
    }
    if (items.length === limit || bytes + valueBytes > byteLimit) {
      return { items, bytes, nextIndex: index };
    }
    items.push(values[index]);
    bytes += valueBytes;
  }
  return { items, bytes };
}

async function worklogRecordAction(
  provider: NotesProvider,
  params: NotesParams,
  signal: AbortSignal | undefined,
  now: () => Date,
) {
  const text = requireItemText(params.text, "Worklog record");
  const date = localDate(now());
  const path = recordPath(date);
  const current = await readOptionalDocument(provider, path, signal);
  const content = current
    ? appendSectionItem(current.content, "Worklog", text)
    : newWorklogRecord(date, text);
  assertNoteSize(content);
  const mutation = validateMutation(
    await provider.write({ path, content, expectedRevision: current?.revision ?? null }, signal),
    path,
  );
  return result(`Recorded Worklog item in ${path}`, {
    action: params.action,
    collection: "worklog",
    path,
    revision: mutation.revision,
  });
}

async function wikiReadAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const target = wikiTarget(params.target);
  if (target.kind === "file") {
    const note = validateDocument(await provider.read(target.path, signal), target.path);
    return result(formatDocument(note.path, note.revision, note.content), {
      action: params.action,
      collection: "wiki",
      path: note.path,
      revision: note.revision,
    });
  }
  const entries = await listComplete(provider, target.path, signal);
  const children = wikiChildren(entries, target.target);
  const scope = target.target || "/";
  const cursor = decodeCursor(params.cursor, "wiki", scope);
  const offset =
    cursor.location === undefined
      ? cursor.offset
      : children.findIndex((child) => wikiChildCursorKey(child) === cursor.location);
  if (offset < 0) throw invalidCollectionCursor();
  const envelope = page(children, collectionLimit(params.limit), offset, (next) =>
    encodeCursor("wiki", scope, 0, wikiChildCursorKey(children[next])),
  );
  return collectionResult(collectionText("Wiki", envelope), {
    action: params.action,
    collection: "wiki",
    items: envelope.items,
    nextCursor: envelope.nextCursor,
  });
}

async function wikiWriteAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const target = wikiTarget(params.target);
  if (target.kind !== "file") throw new Error("notes wiki write requires a Markdown file target");
  if (params.content === undefined) throw new Error("notes wiki write requires content");
  assertNoteSize(params.content);
  const mutation = validateMutation(
    await provider.write(
      {
        path: target.path,
        content: params.content,
        expectedRevision: requireWriteRevision(params),
      },
      signal,
    ),
    target.path,
  );
  return result(`Wrote ${mutation.path}`, {
    action: params.action,
    collection: "wiki",
    path: mutation.path,
    revision: mutation.revision,
  });
}

async function canonicalPaths(
  provider: NotesProvider,
  prefix: string,
  dateFromPath: (path: string) => string | undefined,
  order: "newest" | "chronological",
  signal?: AbortSignal,
): Promise<string[]> {
  const entries = await listComplete(provider, prefix, signal);
  const paths = entries
    .filter((entry) => dateFromPath(entry.path) !== undefined)
    .map((entry) => entry.path);
  paths.sort((left, right) => left.localeCompare(right));
  if (order === "newest") paths.reverse();
  return paths;
}

async function listComplete(provider: NotesProvider, prefix: string, signal?: AbortSignal) {
  const entries: NoteEntry[] = [];
  const paths = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    pages += 1;
    if (pages > MAX_PROVIDER_LIST_PAGES) {
      throw new NotesProviderError({
        code: "resource-limit",
        message: `Collection inventory exceeds ${MAX_PROVIDER_LIST_PAGES} provider pages.`,
      });
    }
    const pageLimit = Math.min(1_000, MAX_NOTE_COUNT - entries.length);
    if (pageLimit === 0) {
      throw new NotesProviderError({
        code: "resource-limit",
        message: `Collection inventory exceeds ${MAX_NOTE_COUNT} notes.`,
      });
    }
    const listed = validateListResult(
      await provider.list(
        { prefix, limit: pageLimit, ...(cursor === undefined ? {} : { cursor }) },
        signal,
      ),
      pageLimit,
    );
    for (const entry of listed.entries) {
      if (paths.has(entry.path)) {
        throw providerContractError("Notes provider returned a duplicate paginated list entry.");
      }
      paths.add(entry.path);
      entries.push(entry);
    }
    if (listed.nextCursor !== undefined && listed.nextCursor === cursor) {
      throw providerContractError("Notes provider returned a non-advancing list cursor.");
    }
    cursor = listed.nextCursor;
  } while (cursor !== undefined);
  return entries;
}

async function readOptionalDocument(
  provider: NotesProvider,
  path: string,
  signal?: AbortSignal,
): Promise<NoteDocument | undefined> {
  try {
    return validateDocument(await provider.read(path, signal), path);
  } catch (cause) {
    if (cause instanceof NotesProviderError && cause.code === "not-found") return undefined;
    throw cause;
  }
}

function collectionLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_COLLECTION_LIMIT, MAX_COLLECTION_LIMIT);
}

function requireInboxKind(kind: NotesParams["kind"]): InboxItemKind {
  if (kind === "note" || kind === "followup") return kind;
  throw new Error("notes inbox write requires kind note or followup");
}

function requireItemText(text: string | undefined, operation: string): string {
  if (text === undefined || text.trim() === "") throw new Error(`${operation} requires text`);
  return text;
}

function invalidCollectionAction(collection: string, action: string): Error {
  return new Error(`notes ${collection} does not support action ${action}`);
}

function wikiChildCursorKey(child: { readonly kind: string; readonly target: string }): string {
  return `${child.kind}:${child.target}`;
}

function invalidCollectionCursor(): NotesProviderError {
  return new NotesProviderError({
    code: "invalid-path",
    message: "Notes continuation cursor no longer matches the collection inventory.",
  });
}

function collectionText(
  label: string,
  envelope: { readonly items: readonly unknown[]; readonly nextCursor?: string },
): string {
  return `${label} results:\n${JSON.stringify(envelope, null, 2)}`;
}

function collectionResult(text: string, details: NotesToolDetails) {
  return result(text, details);
}

async function indexAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const index = validateIndex(await provider.index(signal));
  return result(index.text, { action: params.action, notes: index.entries });
}

async function listAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const prefix = params.prefix === undefined ? undefined : normalizePrefix(params.prefix);
  const limit = Math.min(params.limit ?? MAX_DETAIL_ITEMS, MAX_DETAIL_ITEMS);
  const listed = validateListResult(
    await provider.list(
      { prefix, limit, ...(params.cursor === undefined ? {} : { cursor: params.cursor }) },
      signal,
    ),
    limit,
  );
  return result(formatList(listed.entries, prefix, listed.nextCursor), {
    action: params.action,
    notes: listed.entries,
    nextCursor: listed.nextCursor,
    ...(listed.nextCursor === undefined ? {} : { truncated: true }),
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
  if (path !== note.path) {
    throw providerContractError("Notes provider returned a noncanonical document path.");
  }
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

function validateListResult(result: unknown, limit = MAX_NOTE_COUNT): NotesListResult {
  if (Array.isArray(result)) {
    const entries = validateEntries(result as readonly NoteEntry[]);
    if (entries.length > limit) {
      throw providerContractError("Notes provider returned more list entries than requested.");
    }
    return { entries };
  }
  if (!isRecord(result) || !Array.isArray(result.entries)) {
    throw providerContractError("Notes provider returned an invalid list result.");
  }
  const entries = validateEntries(result.entries as readonly NoteEntry[]);
  if (entries.length > limit) {
    throw providerContractError("Notes provider returned more list entries than requested.");
  }
  const nextCursor = validateOptionalText(result.nextCursor, MAX_LIST_CURSOR_LENGTH, "list cursor");
  if (nextCursor === "" || (nextCursor !== undefined && entries.length === 0)) {
    throw providerContractError("Notes provider returned a non-advancing list cursor.");
  }
  return { entries, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function validateEntries(entries: readonly NoteEntry[]): readonly NoteEntry[] {
  if (!Array.isArray(entries) || entries.length > MAX_NOTE_COUNT) {
    throw providerContractError("Notes provider returned too many entries.");
  }
  const paths = new Set<string>();
  return entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      throw providerContractError("Notes provider returned an invalid note entry.");
    }
    const path = normalizeStorePath(entry.path, true);
    if (path !== entry.path || paths.has(path)) {
      throw providerContractError(
        "Notes provider returned duplicate or noncanonical note entries.",
      );
    }
    paths.add(path);
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
  if (path !== searchResult.path) {
    throw providerContractError("Notes provider returned a noncanonical search-result path.");
  }
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
  if (path !== mutation.path) {
    throw providerContractError("Notes provider returned a noncanonical mutation path.");
  }
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
  const items = details.items?.slice(0, MAX_DETAIL_ITEMS);
  const truncated =
    (details.notes?.length ?? 0) > MAX_DETAIL_ITEMS ||
    (details.results?.length ?? 0) > MAX_DETAIL_ITEMS ||
    (details.items?.length ?? 0) > MAX_DETAIL_ITEMS;
  return {
    ...details,
    ...(notes === undefined ? {} : { notes }),
    ...(results === undefined ? {} : { results }),
    ...(items === undefined ? {} : { items }),
    ...(truncated ? { truncated: true } : {}),
  };
}

function formatDocument(path: string, revision: string, content: string): string {
  return `[Note path=${JSON.stringify(path)} revision=${JSON.stringify(revision)}]\n${content}`;
}

function formatList(notes: readonly NoteEntry[], prefix?: string, nextCursor?: string): string {
  const header = `Found ${notes.length} note(s)${prefix ? ` under ${prefix}` : ""}:`;
  return [
    header,
    ...notes.map((note) => `- ${note.path}${note.size === undefined ? "" : ` (${note.size}B)`}`),
    ...(nextCursor === undefined ? [] : [`Continuation cursor: ${nextCursor}`]),
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
