import { NotesProviderError, type NoteEntry } from "./domain";

export const DEFAULT_COLLECTION_LIMIT = 20;
export const MAX_COLLECTION_LIMIT = 200;
export const MAX_COLLECTION_RESULT_BYTES = 32_768;

export type CollectionOrder = "newest" | "chronological";
export type InboxItemKind = "note" | "followup";

export interface InboxItem {
  readonly date: string;
  readonly kind: InboxItemKind;
  readonly text: string;
  readonly nestedDetails: readonly string[];
  readonly checked?: boolean;
  readonly sourcePath: string;
  readonly position: number;
}

export interface WorklogItem {
  readonly date: string;
  readonly text: string;
  readonly nestedDetails: readonly string[];
  readonly sourcePath: string;
  readonly position: number;
}

export interface WikiChild {
  readonly kind: "folder" | "file";
  readonly target: string;
  readonly path: string;
  readonly revision?: string;
  readonly size?: number;
  readonly modifiedAt?: number;
}

interface CursorPayload {
  readonly v: 1;
  readonly collection: "inbox" | "worklog" | "wiki";
  readonly scope: string;
  readonly offset: number;
  readonly location?: string;
}

export interface CursorPosition {
  readonly offset: number;
  readonly location?: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INBOX_PATH = /^inbox\/(\d{4})\/(\d{2})\/(\d{2})\.md$/;
const RECORD_PATH = /^records\/(\d{4})\/(\d{2})\/(\d{2})\.md$/;

export function localDate(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function requireIsoDate(value: string): string {
  const match = ISO_DATE.exec(value);
  if (!match) throw invalidSelector(`Invalid ISO date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month <= 0 || month > 12 || day <= 0 || day > daysInMonth[month - 1]) {
    throw invalidSelector(`Invalid ISO date: ${value}`);
  }
  return value;
}

export function inboxPath(date: string): string {
  const [year, month, day] = requireIsoDate(date).split("-");
  return `inbox/${year}/${month}/${day}.md`;
}

export function recordPath(date: string): string {
  const [year, month, day] = requireIsoDate(date).split("-");
  return `records/${year}/${month}/${day}.md`;
}

export function inboxDateFromPath(path: string): string | undefined {
  return dateFromPath(path, INBOX_PATH);
}

export function recordDateFromPath(path: string): string | undefined {
  return dateFromPath(path, RECORD_PATH);
}

function dateFromPath(path: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(path);
  if (!match) return undefined;
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  try {
    return requireIsoDate(candidate);
  } catch {
    return undefined;
  }
}

export interface WorklogSelection {
  readonly scope: string;
  readonly matches: (date: string) => boolean;
}

export function worklogSelection(selector: string | undefined, today: string): WorklogSelection {
  const selected = selector?.trim() || today;
  if (selected === "all") return { scope: "all", matches: () => true };
  const separator = selected.indexOf("..");
  if (separator >= 0) {
    const start = requireIsoDate(selected.slice(0, separator));
    const end = requireIsoDate(selected.slice(separator + 2));
    if (start > end) throw invalidSelector("Worklog range start must not be after its end.");
    return {
      scope: `${start}..${end}`,
      matches: (date) => date >= start && date <= end,
    };
  }
  const exact = requireIsoDate(selected);
  return { scope: exact, matches: (date) => date === exact };
}

export function extractInboxItems(content: string, date: string, sourcePath: string): InboxItem[] {
  return [
    ...extractListItems(content, "Follow-ups", "followup", date, sourcePath),
    ...extractListItems(content, "Notes", "note", date, sourcePath),
  ].sort((left, right) => left.position - right.position);
}

export function extractWorklogItems(
  content: string,
  date: string,
  sourcePath: string,
): WorklogItem[] {
  return extractListItems(content, "Worklog", "worklog", date, sourcePath);
}

function extractListItems(
  content: string,
  heading: string,
  kind: InboxItemKind,
  date: string,
  sourcePath: string,
): InboxItem[];
function extractListItems(
  content: string,
  heading: string,
  kind: "worklog",
  date: string,
  sourcePath: string,
): WorklogItem[];
function extractListItems(
  content: string,
  heading: string,
  kind: InboxItemKind | "worklog",
  date: string,
  sourcePath: string,
): Array<InboxItem | WorklogItem> {
  const lines = content.split(/\r?\n/);
  const bounds = sectionBounds(lines, heading);
  if (!bounds) return [];
  const visible = visibleMarkdownLines(lines);
  const items: Array<InboxItem | WorklogItem> = [];
  for (let index = bounds.start; index < bounds.end; index += 1) {
    if (!visible[index]) continue;
    const parsed = parseListItem(lines[index], kind);
    if (parsed === undefined) continue;
    const base = {
      date,
      text: parsed.text,
      nestedDetails: collectNestedDetails(lines, visible, index + 1, bounds.end),
      sourcePath,
      position: index + 1,
    };
    items.push(kind === "worklog" ? base : { ...base, kind, ...parsed.state });
  }
  return items;
}

function parseListItem(
  line: string,
  kind: InboxItemKind | "worklog",
): { readonly text: string; readonly state: { readonly checked?: boolean } } | undefined {
  const followup = /^- \[([ xX])\](?:\s+(.*))?$/.exec(line);
  if (kind === "followup") {
    const text = followup?.[2]?.trim() ?? "";
    return text ? { text, state: { checked: followup?.[1].toLowerCase() === "x" } } : undefined;
  }
  if (followup !== null) return undefined;
  const text = /^-\s+(.*)$/.exec(line)?.[1].trim() ?? "";
  return text ? { text, state: {} } : undefined;
}

function collectNestedDetails(
  lines: readonly string[],
  visible: readonly boolean[],
  start: number,
  end: number,
): string[] {
  const details: string[] = [];
  for (let index = start; index < end; index += 1) {
    if (visible[index] && /^-\s/.test(lines[index])) break;
    if (!visible[index]) continue;
    if (/^[ \t]+\S/.test(lines[index])) details.push(lines[index].trim());
    else if (lines[index].trim() !== "") break;
  }
  return details;
}

export function appendSectionItem(
  content: string,
  heading: "Follow-ups" | "Notes" | "Worklog",
  text: string,
): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalizedText = normalizeItemText(text);
  const marker = heading === "Follow-ups" ? "- [ ] " : "- ";
  const bullet = `${marker}${normalizedText.split(/\r?\n/).join(`${newline}  `)}`;
  const lines = content.split(newline);
  const bounds = sectionBounds(lines, heading);
  if (!bounds) {
    const prefix =
      content.length === 0 ? "" : content.endsWith(newline) ? newline : newline.repeat(2);
    return `${content}${prefix}## ${heading}${newline}${newline}${bullet}${newline}`;
  }
  const visible = visibleMarkdownLines(lines);
  const blankPattern = heading === "Follow-ups" ? /^- \[ \]\s*$/ : /^-\s*$/;
  for (let index = bounds.start; index < bounds.end; index += 1) {
    if (!visible[index] || !blankPattern.test(lines[index])) continue;
    lines[index] = bullet;
    return lines.join(newline);
  }
  let insertAt = bounds.end;
  while (insertAt > bounds.start && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, bullet);
  return lines.join(newline);
}

export function newInboxNote(kind: InboxItemKind, text: string): string {
  const base = "## Follow-ups\n\n- [ ]\n\n## Notes\n\n-\n";
  return appendSectionItem(base, kind === "followup" ? "Follow-ups" : "Notes", text);
}

export function newWorklogRecord(date: string, text: string): string {
  return `---\ntype: record\ndate: ${requireIsoDate(date)}\n---\n# Record — ${date}\n\n## Worklog\n\n- ${normalizeItemText(text).split("\n").join("\n  ")}\n`;
}

function normalizeItemText(text: string): string {
  const normalized = text.trim();
  if (!normalized) throw invalidSelector("Note item text must not be empty.");
  return normalized;
}

function sectionBounds(
  lines: readonly string[],
  heading: string,
): { readonly start: number; readonly end: number } | undefined {
  const visible = visibleMarkdownLines(lines);
  const header = `## ${heading}`;
  const headingIndex = lines.findIndex(
    (line, index) => visible[index] && line.trimEnd() === header,
  );
  if (headingIndex < 0) return undefined;
  const relativeEnd = lines
    .slice(headingIndex + 1)
    .findIndex((line, index) => visible[headingIndex + index + 1] && /^##(?:\s|$)/.test(line));
  const end = relativeEnd < 0 ? lines.length : headingIndex + relativeEnd + 1;
  return { start: headingIndex + 1, end };
}

function visibleMarkdownLines(lines: readonly string[]): boolean[] {
  const visible: boolean[] = [];
  let fence: { readonly character: string; readonly length: number } | undefined;
  for (const line of lines) {
    if (fence !== undefined) {
      visible.push(false);
      if (isClosingFence(line, fence)) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const opensFence = opening !== null && (opening[1][0] === "~" || !opening[2].includes("`"));
    visible.push(!opensFence);
    if (opensFence && opening !== null) {
      fence = { character: opening[1][0], length: opening[1].length };
    }
  }
  return visible;
}

function isClosingFence(
  line: string,
  fence: { readonly character: string; readonly length: number },
): boolean {
  const candidate = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1];
  return (
    candidate !== undefined && candidate[0] === fence.character && candidate.length >= fence.length
  );
}

export function wikiTarget(target: string | undefined): {
  readonly target: string;
  readonly path: string;
  readonly kind: "file" | "folder";
} {
  const normalized = (target ?? "").replaceAll("\\", "/");
  if (/^\//.test(normalized) || (normalized.length > 0 && normalized.endsWith("/"))) {
    throw new NotesProviderError({
      code: "invalid-path",
      message: `Invalid Wiki target: ${target}`,
    });
  }
  const segments = normalized === "" ? [] : normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === ".." || segment.startsWith("."))) {
    throw new NotesProviderError({
      code: "path-escape",
      message: `Wiki target escapes wiki/: ${target}`,
    });
  }
  if (normalized.includes(":") || /[\x00-\x1f\x7f]/.test(normalized)) {
    throw new NotesProviderError({
      code: "invalid-path",
      message: `Invalid Wiki target: ${target}`,
    });
  }
  const kind = normalized.toLowerCase().endsWith(".md") ? "file" : "folder";
  const path = normalized ? `wiki/${normalized}${kind === "folder" ? "/" : ""}` : "wiki/";
  if (path.length > 1_024) {
    throw new NotesProviderError({ code: "invalid-path", message: "Wiki target is too long." });
  }
  return { target: normalized, path, kind };
}

export function wikiChildren(entries: readonly NoteEntry[], folderTarget: string): WikiChild[] {
  const prefix = folderTarget ? `wiki/${folderTarget}/` : "wiki/";
  const children = new Map<string, WikiChild>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    if (!relative) continue;
    const slash = relative.indexOf("/");
    if (slash >= 0) {
      const name = relative.slice(0, slash);
      const target = folderTarget ? `${folderTarget}/${name}` : name;
      children.set(`folder:${target}`, { kind: "folder", target, path: `wiki/${target}/` });
      continue;
    }
    const target = folderTarget ? `${folderTarget}/${relative}` : relative;
    children.set(`file:${target}`, {
      kind: "file",
      target,
      path: entry.path,
      ...(entry.revision === undefined ? {} : { revision: entry.revision }),
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt }),
    });
  }
  return [...children.values()].sort((left, right) =>
    left.kind === right.kind
      ? left.target.localeCompare(right.target)
      : left.kind === "folder"
        ? -1
        : 1,
  );
}

export function encodeCursor(
  collection: CursorPayload["collection"],
  scope: string,
  offset: number,
  location?: string,
): string {
  const payload: CursorPayload = {
    v: 1,
    collection,
    scope,
    offset,
    ...(location === undefined ? {} : { location }),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(
  cursor: string | undefined,
  collection: CursorPayload["collection"],
  scope: string,
): CursorPosition {
  if (cursor === undefined) return { offset: 0 };
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      payload.v !== 1 ||
      payload.collection !== collection ||
      payload.scope !== scope ||
      !Number.isSafeInteger(payload.offset) ||
      (payload.offset ?? -1) < 0 ||
      (payload.location !== undefined && typeof payload.location !== "string")
    ) {
      throw new Error("mismatch");
    }
    return {
      offset: payload.offset as number,
      ...(payload.location === undefined ? {} : { location: payload.location }),
    };
  } catch {
    throw invalidSelector("Invalid or mismatched notes continuation cursor.");
  }
}

export function page<T>(
  values: readonly T[],
  limit: number,
  offset: number,
  cursorFor: (nextOffset: number) => string,
): { readonly items: readonly T[]; readonly nextCursor?: string } {
  const items: T[] = [];
  let bytes = 0;
  let nextOffset = offset;
  while (nextOffset < values.length && items.length < limit) {
    const value = values[nextOffset];
    const valueBytes = Buffer.byteLength(JSON.stringify(value));
    if (valueBytes > MAX_COLLECTION_RESULT_BYTES) {
      throw new NotesProviderError({
        code: "resource-limit",
        message: "One collection item exceeds the result byte limit.",
      });
    }
    if (items.length > 0 && bytes + valueBytes > MAX_COLLECTION_RESULT_BYTES) break;
    items.push(value);
    bytes += valueBytes;
    nextOffset += 1;
  }
  return {
    items,
    ...(nextOffset < values.length ? { nextCursor: cursorFor(nextOffset) } : {}),
  };
}

function invalidSelector(message: string): NotesProviderError {
  return new NotesProviderError({ code: "invalid-path", message });
}
