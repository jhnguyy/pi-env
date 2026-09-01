import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type, type Static } from "typebox";

import type { NotesProvider } from "./domain";
import type { DomainToolContext, ToolContract } from "../_shared/tool-contract";

export const MAX_DETAIL_ITEMS = 200;

export const NOTES_ACTIONS = [
  "index",
  "list",
  "read",
  "search",
  "write",
  "edit",
  "delete",
] as const;

export const NOTES_PARAMETERS = Type.Object({
  action: StringEnum(NOTES_ACTIONS, { description: "Notes operation to perform" }),
  path: Type.Optional(
    Type.String({ description: "Vault-relative Markdown path for read, write, edit, or delete" }),
  ),
  prefix: Type.Optional(Type.String({ description: "Optional vault-relative prefix for list" })),
  query: Type.Optional(Type.String({ description: "Text or path query for search" })),
  content: Type.Optional(Type.String({ description: "Markdown content for write" })),
  edits: Type.Optional(
    Type.Array(
      Type.Object({
        oldText: Type.String({ description: "Exact text that must occur once" }),
        newText: Type.String({ description: "Replacement text" }),
      }),
      { description: "Exact replacements for edit" },
    ),
  ),
  append: Type.Optional(Type.String({ description: "Markdown text to append during edit" })),
});

export type NotesParams = Static<typeof NOTES_PARAMETERS>;

export interface NotesToolDetails {
  readonly action: NotesParams["action"];
  readonly path?: string;
  readonly notes?: readonly unknown[];
  readonly results?: readonly unknown[];
  readonly truncated?: boolean;
}

export const NOTES_DESCRIPTION = [
  "Manage Markdown notes through the provider configured in Pi settings.",
  "Use index before the first store interaction in a task.",
  "Use list with a prefix for complete folder inventory.",
  "Use read or search before editing an existing note.",
  "Write, edit, and delete mutate notes.",
].join(" ");

export function createNotesContract(
  provider: NotesProvider,
): ToolContract<NotesParams, NotesToolDetails, typeof NOTES_PARAMETERS> {
  return {
    name: "notes",
    label: "Notes",
    description: NOTES_DESCRIPTION,
    parameters: NOTES_PARAMETERS,
    execute: (params, context) => executeNotesAction(provider, params, context),
  };
}

async function executeNotesAction(
  provider: NotesProvider,
  params: NotesParams,
  context: DomainToolContext,
) {
  const effect = actionEffect(provider, params);
  const run = () =>
    Effect.runPromise(effect, context.signal ? { signal: context.signal } : undefined);
  if (params.action !== "write" && params.action !== "edit" && params.action !== "delete") {
    return run();
  }
  const notePath = requirePath(params);
  return withFileMutationQueue(provider.queuePath(notePath), run);
}

function actionEffect(
  provider: NotesProvider,
  params: NotesParams,
): Effect.Effect<
  {
    content: Array<{ type: "text"; text: string }>;
    details: NotesToolDetails;
  },
  unknown
> {
  switch (params.action) {
    case "index":
      return Effect.map(provider.index(), (index) => result(index, { action: params.action }));
    case "list":
      return Effect.map(provider.list(params.prefix), (notes) =>
        result(formatList(notes, params.prefix), {
          action: params.action,
          notes,
        }),
      );
    case "read": {
      const notePath = requirePath(params);
      return Effect.map(provider.read(notePath), (content) =>
        result(content, { action: params.action, path: notePath }),
      );
    }
    case "search": {
      if (!params.query) throw new Error("notes search requires query");
      return Effect.map(provider.search(params.query), (results) =>
        result(formatSearch(results), {
          action: params.action,
          results,
        }),
      );
    }
    case "write": {
      const notePath = requirePath(params);
      if (params.content === undefined) throw new Error("notes write requires content");
      return Effect.as(
        provider.write(notePath, params.content),
        result(`Wrote ${notePath}`, {
          action: params.action,
          path: notePath,
        }),
      );
    }
    case "edit": {
      const notePath = requirePath(params);
      if ((!params.edits || params.edits.length === 0) && params.append === undefined) {
        throw new Error("notes edit requires edits or append");
      }
      return Effect.as(
        provider.edit(notePath, params.edits ?? [], params.append),
        result(`Edited ${notePath}`, {
          action: params.action,
          path: notePath,
        }),
      );
    }
    case "delete": {
      const notePath = requirePath(params);
      return Effect.as(
        provider.delete(notePath),
        result(`Deleted ${notePath}`, {
          action: params.action,
          path: notePath,
        }),
      );
    }
  }
}

function requirePath(params: NotesParams): string {
  if (!params.path) throw new Error(`notes ${params.action} requires path`);
  return params.path.replace(/^@/, "");
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

function formatList(notes: readonly { path: string; size?: number }[], prefix?: string): string {
  const header = `Found ${notes.length} note(s)${prefix ? ` under ${prefix}` : ""}:`;
  return [
    header,
    ...notes.map((note) => `- ${note.path}${note.size === undefined ? "" : ` (${note.size}B)`}`),
  ].join("\n");
}

function formatSearch(
  results: readonly { path: string; title?: string; snippet?: string }[],
): string {
  if (results.length === 0) return "No matching notes.";
  return results
    .map((searchResult, index) => {
      const title = searchResult.title ? ` — ${searchResult.title}` : "";
      const snippet = searchResult.snippet ? `\n  ${searchResult.snippet}` : "";
      return `${index + 1}. ${searchResult.path}${title}${snippet}`;
    })
    .join("\n");
}
