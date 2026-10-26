import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DEFAULT_SESSION_DIR, assertUnderSessionDir, inspectEntries, discoverSessionFiles, parseSessionLines, readSessionFile, type ParsedSessionEntries } from "./sessions";
import { inspectSessionUsage, USAGE_REFERENCE_SCHEMA } from "./usage";

const FIELD_SCHEMA = Type.Union([
  Type.Literal("metadata"), Type.Literal("tools"), Type.Literal("skills"), Type.Literal("prompts"),
  Type.Literal("errors"), Type.Literal("labels"), Type.Literal("branches"), Type.Literal("compactions"),
]);

export const READ_SCHEMA = Type.Object({
  sessionId: Type.Optional(Type.String({ minLength: 1, description: "Exact session header ID from list_sessions. Includes discovery of nested sessions. Supply this or path, not both." })),
  path: Type.Optional(Type.String({ minLength: 1, description: `Session .jsonl path under ${DEFAULT_SESSION_DIR}/. Alternative to sessionId.` })),
  mode: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("detailed"), Type.Literal("usage")], {
    description: "Default basic: metadata and tool/skill count dictionaries. Detailed: all sparse fields plus call evidence and recorded timing. Usage: tool/skill dictionaries and call evidence only.",
  })),
  fields: Type.Optional(Type.Array(FIELD_SCHEMA, { minItems: 1, uniqueItems: true, description: "Override the mode's default fields. No unrequested sections are returned." })),
  tool: Type.Optional(Type.String({ minLength: 1, description: "Exact recorded tool name. Filters usage evidence, not prose." })),
  skill: Type.Optional(Type.String({ minLength: 1, description: "Exact skill name. Successful SKILL.md reads use parent directory names. Skill envelopes use their recorded names." })),
  argument: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Case-insensitive literal substring in JSON-serialized call arguments. Argument values are not returned." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum call references in detailed/usage modes, default 20. Dictionaries cover all matching records in the selected file." })),
});

const COUNT_SCHEMA = Type.Record(Type.String(), Type.Number());
const LINE_TEXT_SCHEMA = Type.Object({ line: Type.Number(), text: Type.String() });
export const READ_OUTPUT_SCHEMA = Type.Object({
  file: Type.String(), sessionId: Type.Optional(Type.String()),
  mode: Type.Union([Type.Literal("basic"), Type.Literal("detailed"), Type.Literal("usage")]),
  metadata: Type.Optional(Type.Object({
    name: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), timestamp: Type.String(),
    userTurns: Type.Number(), assistantTurns: Type.Number(), toolResults: Type.Number(), toolErrors: Type.Number(),
    branches: Type.Number(), compacted: Type.Boolean(), bytes: Type.Number(),
  })),
  toolCounts: Type.Optional(COUNT_SCHEMA), toolErrorCounts: Type.Optional(COUNT_SCHEMA),
  skillReadCounts: Type.Optional(COUNT_SCHEMA), skillEnvelopeCounts: Type.Optional(COUNT_SCHEMA),
  matchedRecords: Type.Optional(Type.Number()), incompleteNestedRecords: Type.Optional(Type.Boolean()),
  referencesTruncated: Type.Optional(Type.Boolean()),
  references: Type.Optional(Type.Array(USAGE_REFERENCE_SCHEMA)),
  userPrompts: Type.Optional(Type.Array(LINE_TEXT_SCHEMA)),
  toolErrors: Type.Optional(Type.Array(Type.Object({ line: Type.Number(), toolName: Type.String() }))),
  labels: Type.Optional(Type.Array(Type.Object({ targetId: Type.String(), label: Type.String() }))),
  branchSummaries: Type.Optional(Type.Array(LINE_TEXT_SCHEMA)),
  compactions: Type.Optional(Type.Array(Type.Object({ line: Type.Number(), tokensBefore: Type.Optional(Type.Number()), text: Type.String() }))),
});

type ReadParams = Static<typeof READ_SCHEMA>;
type ReadResult = Static<typeof READ_OUTPUT_SCHEMA>;
type Field = Static<typeof FIELD_SCHEMA>;
const DEFAULT_FIELDS: Record<ReadResult["mode"], Field[]> = {
  basic: ["metadata", "tools", "skills"],
  detailed: ["metadata", "tools", "skills", "prompts", "errors", "labels", "branches", "compactions"],
  usage: ["tools", "skills"],
};

function guardedPath(path: string): string {
  const file = assertUnderSessionDir(path);
  return assertUnderSessionDir(realpathSync(file), realpathSync(DEFAULT_SESSION_DIR));
}

function headerId(file: string, buffer: Buffer): string | undefined {
  const descriptor = openSync(file, "r");
  try {
    // Discovery parses only a bounded header, not transcript bodies.
    const size = readSync(descriptor, buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, size);
    const newline = contents.indexOf(0x0a);
    const line = contents.toString("utf8", 0, newline === -1 ? size : newline);
    const header: unknown = JSON.parse(line);
    if (header && typeof header === "object" && "type" in header && header.type === "session" && "id" in header && typeof header.id === "string") return header.id;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  } finally {
    closeSync(descriptor);
  }
}

async function resolveFile(params: ReadParams, signal?: AbortSignal): Promise<string> {
  if ((params.path === undefined) === (params.sessionId === undefined)) throw new Error("Supply exactly one of sessionId or path.");
  if (params.path !== undefined) return guardedPath(params.path);
  let match: string | undefined;
  const buffer = Buffer.alloc(64 * 1024);
  for (const file of discoverSessionFiles()) {
    await setImmediate(undefined, { signal });
    if (headerId(file, buffer) !== params.sessionId) continue;
    if (match) throw new Error("Session ID is ambiguous. Select an exact path with list_sessions.");
    match = file;
  }
  if (!match) throw new Error("Session ID not found. Use list_sessions to select an exact ID or path.");
  return guardedPath(match);
}

function selectedFields(params: ReadParams): Set<Field> {
  const fields = new Set(params.fields ?? DEFAULT_FIELDS[params.mode ?? "basic"]);
  const hasFilter = params.tool !== undefined || params.skill !== undefined || params.argument !== undefined;
  if (hasFilter && !fields.has("tools") && !fields.has("skills")) throw new Error("Usage filters require the tools or skills field.");
  return fields;
}

function projectNavigation(result: ReadResult, view: ReturnType<typeof inspectEntries>, fields: Set<Field>): void {
  if (fields.has("metadata")) result.metadata = {
    name: view.name, cwd: view.cwd, timestamp: view.timestamp,
    userTurns: view.userTurns, assistantTurns: view.assistantTurns, toolResults: view.toolResults, toolErrors: view.toolErrors,
    branches: view.branches, compacted: view.compacted, bytes: view.bytes,
  };
  if (fields.has("prompts")) result.userPrompts = view.userPrompts;
  if (fields.has("errors")) result.toolErrors = view.toolErrorSummaries.map(({ line, toolName }) => ({ line, toolName }));
  if (fields.has("labels")) result.labels = view.labels;
  if (fields.has("branches")) result.branchSummaries = view.branchSummaries;
  if (fields.has("compactions")) result.compactions = view.compactions;
}

function projectUsage(result: ReadResult, entries: ParsedSessionEntries, fields: Set<Field>, params: ReadParams): void {
  if (!fields.has("tools") && !fields.has("skills")) return;
  const scope = fields.has("tools") ? fields.has("skills") ? "all" : "tools" : "skills";
  const usage = inspectSessionUsage(entries, result.file, { ...params, scope, includeReferences: result.mode !== "basic" });
  result.matchedRecords = usage.matchedRecords;
  result.incompleteNestedRecords = usage.incompleteNestedRecords;
  if (fields.has("tools")) {
    result.toolCounts = usage.toolCounts;
    result.toolErrorCounts = usage.toolErrorCounts;
  }
  if (fields.has("skills")) {
    result.skillReadCounts = usage.skillReadCounts;
    result.skillEnvelopeCounts = usage.skillEnvelopeCounts;
  }
  if (result.mode !== "basic") {
    result.references = usage.references;
    result.referencesTruncated = usage.referencesTruncated;
  }
}

function boundedOutput(result: ReadResult): string {
  let text = JSON.stringify(result, null, 2);
  let truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }).truncated;
  while (truncated && result.references?.length) {
    result.references.pop();
    result.referencesTruncated = true;
    text = JSON.stringify(result, null, 2);
    truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }).truncated;
  }
  if (truncated) throw new Error("Session fields exceed the output budget. Narrow the request with fields, tool, skill, or argument.");
  return text;
}

export async function executeReadSession(params: ReadParams, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const fields = selectedFields(params);
  const file = await resolveFile(params, signal);
  signal?.throwIfAborted();
  const { lines, bytes } = readSessionFile(file);
  const entries = parseSessionLines(lines);
  const header = entries.find((entry) => entry?.type === "session");
  const result: ReadResult = { file, sessionId: header?.id, mode: params.mode ?? "basic" };
  if ([...fields].some((field) => field !== "tools" && field !== "skills")) {
    const view = inspectEntries(entries, file, bytes, {
      prompts: fields.has("prompts"), errors: fields.has("errors"),
      branches: fields.has("branches"), compactions: fields.has("compactions"), summarizePrompts: false, includeErrorText: false,
    });
    projectNavigation(result, view, fields);
  }
  projectUsage(result, entries, fields, params);
  const text = boundedOutput(result);
  return { content: [{ type: "text" as const, text }], details: result, structuredContent: result };
}
