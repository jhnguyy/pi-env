import { basename, dirname, resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { ParsedSessionEntries } from "./sessions";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    const part = record(block);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

export const UsageKind = {
  ToolCall: "tool_call",
  SkillRead: "skill_read",
  SkillEnvelope: "skill_envelope",
} as const;

export const UsageStatus = {
  Ok: "ok",
  Error: "error",
  Unfinished: "unfinished",
  Unknown: "unknown",
} as const;

const USAGE_STATUSES = Object.values(UsageStatus);

export const USAGE_REFERENCE_SCHEMA = Type.Object({
  file: Type.String(), entryId: Type.Optional(Type.String()), line: Type.Number(),
  kind: Type.Enum(UsageKind),
  tool: Type.Optional(Type.String()), skill: Type.Optional(Type.String()), callId: Type.Optional(Type.String()),
  status: Type.Optional(Type.Enum(UsageStatus)),
  nested: Type.Optional(Type.Boolean()), timestamp: Type.Optional(Type.String()), durationMs: Type.Optional(Type.Number()),
});
export type UsageReference = Static<typeof USAGE_REFERENCE_SCHEMA>;

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
  includeReferences?: boolean;
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
  if (call.name !== "read" || call.status !== UsageStatus.Ok) return;
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

function callOutcomes(entries: Array<RecordValue | undefined>, includeTiming: boolean): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      outcomes.set(message.toolCallId, { status: message.isError === true ? UsageStatus.Error : UsageStatus.Ok, durationMs: includeTiming ? duration(message.durationMs) : undefined });
    }
  }
  return outcomes;
}

function parseCall(value: unknown, nested: boolean, outcomes: Map<string, Outcome>, includeTiming: boolean): Call | undefined {
  const part = record(value);
  if (!part || typeof part.name !== "string" || (!nested && part.type !== "toolCall")) return;
  const id = typeof part.id === "string" ? part.id : undefined;
  const nestedStatus = USAGE_STATUSES.find((status) => status === part.status) ?? UsageStatus.Unknown;
  const outcome = id ? outcomes.get(id) : undefined;
  return { name: part.name, id, arguments: part.arguments, nested,
    status: nested ? nestedStatus : outcome?.status ?? UsageStatus.Unknown,
    durationMs: includeTiming ? nested ? duration(part.durationMs) : outcome?.durationMs : undefined };
}

function messageCalls(message: RecordValue, outcomes: Map<string, Outcome>, includeTiming: boolean): Call[] {
  const nested = message.role === "toolResult";
  const values = nested ? record(message.nestedCalls)?.calls : message.content;
  if ((!nested && message.role !== "assistant") || !Array.isArray(values)) return [];
  return values.flatMap((value: unknown) => {
    const call = parseCall(value, nested, outcomes, includeTiming);
    return call ? [call] : [];
  });
}

function matchesCall(call: Call, skill: string | undefined, query: UsageQuery): boolean {
  if (query.scope === "skills" && skill === undefined) return false;
  if (query.tool !== undefined && call.name !== query.tool) return false;
  if (query.skill !== undefined && skill !== query.skill) return false;
  return query.argument === undefined || (JSON.stringify(call.arguments) ?? "").toLowerCase().includes(query.argument);
}

function addReference(result: SessionUsage, source: Source | undefined, call: Call | undefined, skill: string | undefined, limit: number): void {
  result.matchedRecords++;
  if (!source || result.references.length >= limit) return;
  const reference: UsageReference = {
    ...source, skill, kind: call ? skill ? UsageKind.SkillRead : UsageKind.ToolCall : UsageKind.SkillEnvelope,
  };
  if (call) Object.assign(reference, { tool: call.name, callId: call.id, status: call.status, nested: call.nested, durationMs: call.durationMs });
  result.references.push(reference);
}

function collectMessage(result: SessionUsage, message: RecordValue, source: Source | undefined, outcomes: Map<string, Outcome>, query: UsageQuery, limit: number, cwd?: string): void {
  if (message.role === "toolResult" && record(message.nestedCalls)?.complete === false) result.incompleteNestedRecords = true;
  for (const call of messageCalls(message, outcomes, source !== undefined)) {
    const skill = skillRead(call, cwd);
    if (!matchesCall(call, skill, query)) continue;
    increment(result.toolCounts, call.name);
    if (call.status === UsageStatus.Error) increment(result.toolErrorCounts, call.name);
    if (skill) increment(result.skillReadCounts, skill);
    addReference(result, source, call, skill, limit);
  }
  const skill = skillEnvelope(message, query);
  if (skill) {
    increment(result.skillEnvelopeCounts, skill);
    addReference(result, source, undefined, skill, limit);
  }
}

export function inspectSessionUsage(entries: ParsedSessionEntries, file: string, options: UsageQuery = {}): SessionUsage {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const result: SessionUsage = {
    toolCounts: {}, toolErrorCounts: {}, skillReadCounts: {}, skillEnvelopeCounts: {},
    matchedRecords: 0, references: [], referencesTruncated: false, incompleteNestedRecords: false,
  };
  const query = { ...options, argument: options.argument?.toLowerCase() };
  const header = entries.find((entry) => entry?.type === "session");
  const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
  const outcomes = callOutcomes(entries, options.includeReferences !== false);
  entries.forEach((entry, index) => {
    const message = messageOf(entry);
    if (!message) return;
    const source = options.includeReferences !== false && result.references.length < limit
      ? { file, entryId: typeof entry?.id === "string" ? entry.id : undefined, line: index + 1, timestamp: timestamp(entry, message) }
      : undefined;
    collectMessage(result, message, source, outcomes, query, limit, cwd);
  });
  result.referencesTruncated = options.includeReferences !== false && result.matchedRecords > result.references.length;
  return result;
}
