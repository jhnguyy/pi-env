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
  MAX_NOTE_BYTES,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
  NOTES_AREAS,
  NOTES_AREA_PREFIXES,
  NotesProviderError,
  type ExactEdit,
  type NoteEntry,
  type NoteSearchResult,
  type NotesArea,
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

export const NOTES_PARAMETERS = Type.Object({
  action: StringEnum(NOTES_ACTIONS, { description: "Notes operation to perform" }),
  path: Type.Optional(
    Type.String({ maxLength: 1_024, description: "Store-relative Markdown path" }),
  ),
  area: Type.Optional(
    StringEnum(NOTES_AREAS, {
      description: "Canonical area for list: wiki, worklog, or decisions",
    }),
  ),
  areas: Type.Optional(
    Type.Array(StringEnum(NOTES_AREAS), {
      maxItems: NOTES_AREAS.length,
      uniqueItems: true,
      description: "Canonical areas for search: wiki, worklog, or decisions",
    }),
  ),
  prefix: Type.Optional(
    Type.String({ maxLength: 1_024, description: "Optional path prefix for list" }),
  ),
  query: Type.Optional(
    Type.String({
      maxLength: MAX_SEARCH_QUERY_LENGTH,
      description: "Text or path query for search",
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
  reference: Type.Optional(
    Type.String({ maxLength: 256, description: "Provider-owned reference, such as daily/today" }),
  ),
  content: Type.Optional(
    Type.String({ maxLength: MAX_NOTE_BYTES, description: "Markdown content for write" }),
  ),
  revision: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Mutation precondition. Use null to require creation or the revision returned by read.",
    }),
  ),
  edits: Type.Optional(
    Type.Array(
      Type.Object({
        oldText: Type.String({
          maxLength: MAX_NOTE_BYTES,
          description: "Exact text that must occur once",
        }),
        newText: Type.String({ maxLength: MAX_NOTE_BYTES, description: "Replacement text" }),
      }),
      { maxItems: 100, description: "Exact replacements for edit" },
    ),
  ),
  append: Type.Optional(
    Type.String({ maxLength: MAX_NOTE_BYTES, description: "Markdown text to append during edit" }),
  ),
});

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
  "Manage Markdown notes through the provider configured in Pi settings.",
  "Use wiki for current knowledge, worklog for dated events, and decisions for rationale.",
  "Use index before the first store interaction in a task.",
  "Use list with an area or prefix for complete inventory.",
  "Use read or search before editing an existing note.",
  "Mutations require a revision precondition. Use null only when creating a note.",
  "Never store secrets, credentials, private keys, tokens, or raw sensitive dumps in notes.",
  "Write, edit, and delete mutate notes.",
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
}

async function indexAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const notes = await provider.list({}, signal);
  return result(formatIndex(notes), { action: params.action, notes });
}

async function listAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const notes = await provider.list({ area: params.area, prefix: params.prefix }, signal);
  return result(formatList(notes, params.area, params.prefix), { action: params.action, notes });
}

async function readAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const note = await provider.read(requirePath(params), signal);
  return result(note.content, {
    action: params.action,
    path: note.path,
    revision: note.revision,
  });
}

async function searchAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  if (!params.query) throw new Error("notes search requires query");
  const results = await provider.search(
    { query: params.query, areas: params.areas, limit: params.limit },
    signal,
  );
  return result(formatSearch(results), { action: params.action, results });
}

async function resolveAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  if (!params.reference) throw new Error("notes resolve requires reference");
  const note = await provider.resolve(params.reference, signal);
  return result(note.content, {
    action: params.action,
    path: note.path,
    revision: note.revision,
  });
}

async function writeAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const notePath = requirePath(params);
  if (params.content === undefined) throw new Error("notes write requires content");
  const mutation = await provider.write(
    {
      path: notePath,
      content: params.content,
      expectedRevision: requireWriteRevision(params),
    },
    signal,
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
  const note = await provider.read(notePath, signal);
  if (note.revision !== revision) throw conflict(notePath);
  const mutation = await provider.write(
    {
      path: notePath,
      content: applyExactEdits(note.content, params.edits ?? [], params.append),
      expectedRevision: revision,
    },
    signal,
  );
  return result(`Edited ${mutation.path}`, {
    action: params.action,
    path: mutation.path,
    revision: mutation.revision,
  });
}

async function deleteAction(provider: NotesProvider, params: NotesParams, signal?: AbortSignal) {
  const mutation = await provider.delete(
    { path: requirePath(params), expectedRevision: requireExistingRevision(params) },
    signal,
  );
  return result(`Deleted ${mutation.path}`, { action: params.action, path: mutation.path });
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
  return append === undefined ? next : next + append;
}

function requirePath(params: NotesParams): string {
  if (!params.path) throw new Error(`notes ${params.action} requires path`);
  return params.path.replace(/^@/, "");
}

function requireWriteRevision(params: NotesParams): string | null {
  if (params.revision === undefined) {
    throw new Error("notes write requires revision; use null only when creating a note");
  }
  return params.revision;
}

function requireExistingRevision(params: NotesParams): string {
  if (typeof params.revision !== "string" || params.revision.length === 0) {
    throw new Error(`notes ${params.action} requires the revision returned by read`);
  }
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

function formatIndex(notes: readonly NoteEntry[]): string {
  const counts = new Map<NotesArea, number>(NOTES_AREAS.map((area) => [area, 0]));
  for (const note of notes) {
    const area = NOTES_AREAS.find((candidate) =>
      note.path.startsWith(NOTES_AREA_PREFIXES[candidate]),
    );
    if (area) counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [
    `[Notes Index]|count:${notes.length}`,
    ...NOTES_AREAS.map((area) => `|${area}[${counts.get(area) ?? 0}]:${NOTES_AREA_PREFIXES[area]}`),
  ].join("\n");
}

function formatList(notes: readonly NoteEntry[], area?: NotesArea, prefix?: string): string {
  const scope = [area ? `in ${area}` : undefined, prefix ? `under ${prefix}` : undefined]
    .filter((part) => part !== undefined)
    .join(" and ");
  const header = `Found ${notes.length} note(s)${scope ? ` ${scope}` : ""}:`;
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
