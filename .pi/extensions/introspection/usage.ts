import { basename, dirname, resolve } from "node:path";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function parseEntry(line: string): RecordValue | undefined {
  try { return record(JSON.parse(line)); } catch { return undefined; }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    const part = record(block);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

export type UsageReference = {
  file: string;
  entryId?: string;
  line: number;
  kind: "tool_call" | "skill_read" | "skill_envelope";
  tool?: string;
  skill?: string;
  callId?: string;
  status?: "ok" | "error" | "unfinished" | "unknown";
  nested?: boolean;
  timestamp?: string;
  durationMs?: number;
};

export type SessionUsage = {
  toolCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
  skillReadCounts: Record<string, number>;
  skillEnvelopeCounts: Record<string, number>;
  matchedRecords: number;
  references: UsageReference[];
  referencesTruncated: boolean;
  incompleteNestedRecords: boolean;
};

export interface UsageQuery {
  tool?: string;
  skill?: string;
  argument?: string;
  limit?: number;
  scope?: "tools" | "skills" | "all";
}

type Source = Pick<UsageReference, "file" | "entryId" | "line" | "timestamp">;
type Status = NonNullable<UsageReference["status"]>;
interface Call {
  name: string;
  id?: string;
  arguments?: unknown;
  status: Status;
  nested: boolean;
  durationMs?: number;
}

type Outcome = { status: Status; durationMs?: number };

function duration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestamp(entry: RecordValue | undefined, message: RecordValue): string | undefined {
  const value = entry?.timestamp ?? message.timestamp;
  if (typeof value !== "string" && typeof value !== "number") return;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function increment(counts: Record<string, number>, name: string): void {
  // Recorded names such as __proto__ must remain dictionary keys.
  Object.defineProperty(counts, name, {
    value: (Object.hasOwn(counts, name) ? counts[name] : 0) + 1,
    enumerable: true, configurable: true, writable: true,
  });
}

function skillRead(call: Call, cwd?: string): string | undefined {
  if (call.name !== "read" || call.status !== "ok") return;
  const path = record(call.arguments)?.path;
  if (typeof path !== "string" || basename(path) !== "SKILL.md") return;
  return basename(dirname(cwd ? resolve(cwd, path) : path));
}

function skillEnvelope(message: RecordValue, query: UsageQuery): string | undefined {
  if (message.role !== "user" || query.scope === "tools" || query.tool !== undefined || query.argument !== undefined) return;
  // Pi's /skill: expansion has no provenance marker. Manually supplied envelopes look identical.
  const skill = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*\n<\/skill>(?:\n\n[\s\S]+)?$/.exec(textContent(message.content))?.[1];
  return query.skill === undefined || query.skill === skill ? skill : undefined;
}

function messageOf(entry: RecordValue | undefined): RecordValue | undefined {
  return entry?.type === "message" ? record(entry.message) : undefined;
}

function callOutcomes(entries: Array<RecordValue | undefined>): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      outcomes.set(message.toolCallId, { status: message.isError === true ? "error" : "ok", durationMs: duration(message.durationMs) });
    }
  }
  return outcomes;
}

function parseCall(value: unknown, nested: boolean, outcomes: Map<string, Outcome>): Call | undefined {
  const part = record(value);
  if (!part || typeof part.name !== "string" || (!nested && part.type !== "toolCall")) return;
  const id = typeof part.id === "string" ? part.id : undefined;
  const nestedStatus = (["ok", "error", "unfinished"] as const).find((status) => status === part.status) ?? "unknown";
  const outcome = id ? outcomes.get(id) : undefined;
  return { name: part.name, id, arguments: part.arguments, nested,
    status: nested ? nestedStatus : outcome?.status ?? "unknown",
    durationMs: nested ? duration(part.durationMs) : outcome?.durationMs };
}

function messageCalls(message: RecordValue, outcomes: Map<string, Outcome>): Call[] {
  const nested = message.role === "toolResult";
  const values = nested ? record(message.nestedCalls)?.calls : message.content;
  if ((!nested && message.role !== "assistant") || !Array.isArray(values)) return [];
  return values.flatMap((value: unknown) => {
    const call = parseCall(value, nested, outcomes);
    return call ? [call] : [];
  });
}

function matchesCall(call: Call, skill: string | undefined, query: UsageQuery): boolean {
  if (query.scope === "skills" && skill === undefined) return false;
  if (query.tool !== undefined && call.name !== query.tool) return false;
  if (query.skill !== undefined && skill !== query.skill) return false;
  return query.argument === undefined || (JSON.stringify(call.arguments) ?? "").toLowerCase().includes(query.argument.toLowerCase());
}

function addReference(result: SessionUsage, reference: UsageReference, limit: number): void {
  result.matchedRecords++;
  if (result.references.length < limit) result.references.push(reference);
  else result.referencesTruncated = true;
}

function collectMessage(result: SessionUsage, message: RecordValue, source: Source, outcomes: Map<string, Outcome>, query: UsageQuery, limit: number, cwd?: string): void {
  if (message.role === "toolResult" && record(message.nestedCalls)?.complete === false) result.incompleteNestedRecords = true;
  for (const call of messageCalls(message, outcomes)) {
    const skill = skillRead(call, cwd);
    if (!matchesCall(call, skill, query)) continue;
    increment(result.toolCounts, call.name);
    if (call.status === "error") increment(result.toolErrorCounts, call.name);
    if (skill) increment(result.skillReadCounts, skill);
    addReference(result, { ...source, tool: call.name, callId: call.id, status: call.status,
      nested: call.nested, kind: skill ? "skill_read" : "tool_call", skill, durationMs: call.durationMs }, limit);
  }
  const skill = skillEnvelope(message, query);
  if (skill) {
    increment(result.skillEnvelopeCounts, skill);
    addReference(result, { ...source, kind: "skill_envelope", skill }, limit);
  }
}

export function inspectSessionUsage(lines: string[], file: string, options: UsageQuery = {}): SessionUsage {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const result: SessionUsage = {
    toolCounts: {}, toolErrorCounts: {}, skillReadCounts: {}, skillEnvelopeCounts: {},
    matchedRecords: 0, references: [], referencesTruncated: false, incompleteNestedRecords: false,
  };
  const entries = lines.map(parseEntry);
  const header = entries.find((entry) => entry?.type === "session");
  const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
  const outcomes = callOutcomes(entries);
  entries.forEach((entry, index) => {
    const message = messageOf(entry);
    if (!message) return;
    const source = { file, entryId: typeof entry?.id === "string" ? entry.id : undefined, line: index + 1, timestamp: timestamp(entry, message) };
    collectMessage(result, message, source, outcomes, options, limit, cwd);
  });
  return result;
}
