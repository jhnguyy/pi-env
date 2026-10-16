import { createReadStream } from "node:fs";
import { opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { DEFAULT_SESSION_DIR, MessageRole, SessionEntryType } from "./sessions";

export const SEARCH_SCHEMA = Type.Object({
  term: Type.String({ minLength: 1, maxLength: 200, description: "Literal word or phrase to find. Case-insensitive, not a regex." }),
  cwd: Type.Optional(Type.String({ description: "Only search sessions whose recorded cwd exactly matches this path. Defaults to all cwd values." })),
  scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("parent"), Type.Literal("child")], { description: "Session scope. Defaults to all. Child sessions have a parentSession header." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum message matches. Defaults to 20." })),
});
export type SearchSessionsParams = Static<typeof SEARCH_SCHEMA>;

const MAX_MATCH_BYTES = 40 * 1024;

const ENTRY_SCHEMA = Type.Object({
  type: Type.String(),
  id: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cwd: Type.Optional(Type.String()),
  parentSession: Type.Optional(Type.String()),
  message: Type.Optional(Type.Object({
    role: Type.String(),
    content: Type.Union([Type.String(), Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) }))]),
  })),
});
type SearchEntry = Static<typeof ENTRY_SCHEMA>;

export interface SessionMatch {
  file: string;
  sessionId?: string;
  entryId?: string;
  parentId?: string | null;
  line: number;
  role: "user" | "assistant";
  snippet: string;
}

export interface SessionSearchResult {
  matches: SessionMatch[];
  truncated: boolean;
  cancelled: boolean;
}

function parseEntry(line: string): SearchEntry | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    return Check(ENTRY_SCHEMA, entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

async function* sessionFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  if (signal?.aborted) return;
  let directory;
  try {
    directory = await opendir(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for await (const entry of directory) {
    if (signal?.aborted) return;
    const file = join(root, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(file, signal);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield file;
  }
}

function matchingSnippet(entry: SearchEntry, term: RegExp): Pick<SessionMatch, "role" | "snippet"> | undefined {
  const message = entry.message;
  if (entry.type !== SessionEntryType.Message || !message) return undefined;
  if (message.role !== MessageRole.User && message.role !== MessageRole.Assistant) return undefined;
  const text = typeof message.content === "string" ? message.content : message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const match = term.exec(text);
  if (!match) return undefined;
  const start = Math.max(0, match.index - 80);
  const end = Math.min(text.length, match.index + match[0].length + 80);
  return {
    role: message.role,
    snippet: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
  };
}

function acceptsSession(header: SearchEntry, params: SearchSessionsParams): boolean {
  if (params.cwd && (!header.cwd || resolve(header.cwd) !== resolve(params.cwd))) return false;
  switch (params.scope) {
    case "parent": return !header.parentSession;
    case "child": return !!header.parentSession;
    default: return true;
  }
}

async function* searchFile(
  file: string, params: SearchSessionsParams, term: RegExp, signal?: AbortSignal,
): AsyncGenerator<SessionMatch> {
  const input = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: SearchEntry | undefined;
  let line = 0;
  try {
    for await (const raw of lines) {
      if (signal?.aborted) return;
      line += 1;
      const entry = parseEntry(raw);
      if (!entry) continue;
      if (entry.type === SessionEntryType.Session) {
        header = entry;
        if (!acceptsSession(header, params)) return;
        continue;
      }
      if (!header) continue;
      const found = matchingSnippet(entry, term);
      if (found) yield { file, sessionId: header.id, entryId: entry.id, parentId: entry.parentId, line, ...found };
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function searchSessions(
  params: SearchSessionsParams,
  options: { sessionDir?: string; signal?: AbortSignal } = {},
): Promise<SessionSearchResult> {
  const needle = params.term.trim();
  if (!needle) throw new Error("Search term must contain text.");
  // Escape the literal term and preserve source offsets when Unicode case conversion changes length.
  const term = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  const matches: SessionMatch[] = [];
  const limit = params.limit ?? 20;
  let matchBytes = 0;
  try {
    for await (const file of sessionFiles(resolve(options.sessionDir ?? DEFAULT_SESSION_DIR), options.signal)) {
      for await (const match of searchFile(file, params, term, options.signal)) {
        const bytes = Buffer.byteLength(JSON.stringify(match)) + 1;
        if (matches.length === limit || matchBytes + bytes > MAX_MATCH_BYTES) {
          return { matches, truncated: true, cancelled: false };
        }
        matches.push(match);
        matchBytes += bytes;
      }
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error;
  }
  return { matches, truncated: false, cancelled: options.signal?.aborted ?? false };
}
