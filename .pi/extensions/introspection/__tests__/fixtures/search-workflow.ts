import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";

const home = homedir();
const root = join(home, ".pi/agent/sessions/project");
const parent = join(root, "parent.jsonl");
const child = join(root, "_children/parent/child.jsonl");
const usageFile = join(root, "usage.jsonl");
const usageId = "usage-session-id";
const outputFile = join(root, ...Array<string>(8).fill("long-path".repeat(10)), "output.jsonl");
const term = "postgres [db]";
const outputTerm = "\u0000".repeat(200);
const outputSnippet = `${"\u0001".repeat(80)}${outputTerm}${"\u0001".repeat(80)}`;
const faux = fauxProvider();
let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
let wasDeferred = false;

function message(id: string, role: string, content: unknown, parentId: string | null = "u1") {
  return { type: "message", id, parentId, timestamp: "2026-10-25T00:00:00.000Z", message: { role, content } };
}

function writeTranscript(file: string, cwd: string, entries: object[], id = file): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    { type: "session", id, cwd, timestamp: "2026-10-25T00:00:00.000Z" }, ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n\n") + "\nnot json\n");
}

function createTranscripts(): void {
  writeTranscript(parent, "/fixture", [
    message("u1", "user", "First unrelated prompt", null),
    message("a1", "assistant", [{ type: "text", text: `${"İ".repeat(200)}${"before ".repeat(30)}POSTGRES [db] decision${" after".repeat(30)}` }]),
    message("u2", "user", "Middle postgres [db] question"),
    message("a2", "assistant", [{ type: "thinking", thinking: `${term} private` }, { type: "toolCall", name: "bash", arguments: { command: `${term} command` } }]),
    message("t1", "toolResult", `${term} tool output`),
    { type: "compaction", summary: `${term} generated summary` },
    message("u3", "user", "Last unrelated prompt"),
  ]);
  writeTranscript(child, "/fixture", [message("child-u", "user", `${term} child`, null)]);
  for (const [name, count] of [["limit", 21], ["exact", 20]] as const) {
    writeTranscript(join(root, `${name}.jsonl`), `/${name}`, Array.from({ length: count }, (_, i) => message(`${name}-${i}`, "user", term)));
  }
  writeTranscript(outputFile, "/output", Array.from({ length: 20 }, (_, i) => message(`output-${i}`, "user", outputSnippet)));
  writeTranscript(usageFile, "/usage", [
    message("mentions", "user", "bash read /skill:testing-practices /skills/mentioned/SKILL.md"),
    message("command", "user", '<skill name="testing-practices" location="/skills/testing-practices/SKILL.md">\nInstructions\n</skill>'),
    message("calls", "assistant", [
      { type: "toolCall", id: "b1", name: "bash", arguments: { command: "git status" } },
      { type: "toolCall", id: "r1", name: "read", arguments: { path: "/skills/testing-practices/SKILL.md" } },
      { type: "toolCall", id: "r2", name: "read", arguments: { path: "/skills/failed/SKILL.md" } },
      { type: "toolCall", id: "lost", name: "bash", arguments: { command: "not completed" } },
      { type: "toolCall", id: "wrapper", name: "codemode", arguments: { code: "private-source" } },
    ]),
    ...[["b1", "bash", true], ["r1", "read", false], ["r2", "read", true]].map(([toolCallId, toolName, isError]) => ({ type: "message", id: `result-${toolCallId}`, message: { role: "toolResult", toolCallId, toolName, isError, durationMs: 25, content: [{ type: "text", text: "private-output" }] } })),
    { type: "message", id: "nested", timestamp: "2026-10-25T00:00:01.000Z", message: { role: "toolResult", toolCallId: "wrapper", toolName: "codemode", isError: false, nestedCalls: { complete: false, calls: [
      { id: "wrapper/1", name: "bash", arguments: { command: "git status --short" }, status: "ok", durationMs: 12 },
      { id: "wrapper/2", name: "read", arguments: { path: "/skills/nested-skill/SKILL.md" }, status: "ok" },
      { id: "wrapper/3", name: "read", argumentsBytes: 10000, status: "ok" },
    ] } } },
    { type: "branch_summary", summary: "Ignore bash /skill:summary" },
    { type: "label", targetId: "calls", label: "todo: inspect usage" },
    { type: "compaction", tokensBefore: 100, summary: "Compact usage history" },
  ], usageId);
  writeTranscript(join(root, "_children/usage/child.jsonl"), "/usage", [
    message("child-call", "assistant", [{ type: "toolCall", id: "child-b", name: "bash", arguments: { command: "git status" } }], null),
    { type: "message", message: { role: "toolResult", toolCallId: "child-b", toolName: "bash", isError: false } },
  ], "usage-child-id");
  writeTranscript(join(root, "usage-output.jsonl"), "/usage-output", Array.from({ length: 100 }, (_, i) => message(`call-${i}-${"x".repeat(1000)}`, "assistant", [
    { type: "toolCall", id: `call-${i}`, name: "__proto__", arguments: {} },
  ])));
  for (const [name, count, padding] of [["dictionary-bytes", 1000, 80], ["dictionary-lines", 2100, 0]] as const) {
    writeTranscript(join(root, `${name}.jsonl`), `/${name}`, Array.from({ length: count }, (_, i) => message(`dict-${i}`, "assistant", [
      { type: "toolCall", id: `dict-${i}`, name: `t${i}${"x".repeat(padding)}`, arguments: {} },
    ])));
  }
  writeTranscript(join(root, "untimed.jsonl"), "/untimed", [
    { type: "message", id: "untimed-call", message: { role: "assistant", content: [{ type: "toolCall", id: "untimed", name: "read", arguments: {} }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "untimed", toolName: "read", isError: false } },
  ], "untimed-id");
  writeTranscript(join(root, "ambiguous-a.jsonl"), "/ambiguous", [], "ambiguous-id");
  writeTranscript(join(root, "ambiguous-b.jsonl"), "/ambiguous", [], "ambiguous-id");
  writeFileSync(join(home, "outside.jsonl"), "outside content must not leak");
  symlinkSync(join(home, "outside.jsonl"), join(root, "escape.jsonl"));
  writeTranscript(join(root, "other.jsonl"), "/usage", [message("excluded", "assistant", [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "git status" } }])]);
}

async function invoke(tool: string, params: JsonObject) {
  const start = session.messages.length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(tool, params), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("Execute the session search fixture request.");
  const result = session.messages.slice(start).find((entry) => entry.role === "toolResult" && entry.toolName === tool);
  assert(result?.role === "toolResult", `${tool} must return a tool result for this request`);
  return {
    text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    isError: result.isError,
    details: result.details,
  };
}

const search = (params: { term: string; cwd?: string }) => invoke("search_sessions", params);

async function read(params: JsonObject) {
  const result = await invoke("read_session", params);
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
}

const usage = (params: JsonObject = {}) => read({ sessionId: usageId, mode: "usage", ...params });

function matchRecords(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("{") && line.includes('"entryId":'));
}

// node:test owns completion and reports failed callbacks through the process exit status.
void describe("session introspection public workflow", { concurrency: false }, () => {
  before(async () => {
    createTranscripts();
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["+tool_search"] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const resourceLoader = new DefaultResourceLoader({
      cwd: home, agentDir: home, settingsManager,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../../dist/index.js", import.meta.url))],
      extensionFactories: [createToolSearchExtension()],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: home, agentDir: home, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager,
      sessionManager: SessionManager.inMemory(home),
    }));
    await session.bindExtensions({});
    wasDeferred = !session.getActiveToolNames().includes("search_sessions");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "search_sessions", limit: 1 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Discover the session search tool.");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "read_session", limit: 1 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Discover the session reader.");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "list_sessions", limit: 1 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Discover session navigation.");
  });

  after(async () => {
    await session?.abort();
    session?.dispose();
  });

  void it("discovers the deferred tool", () => {
    assert(wasDeferred);
    assert(session.getActiveToolNames().includes("search_sessions"));
    assert(session.getActiveToolNames().includes("read_session"));
    assert(!session.getActiveToolNames().includes("query_session_usage"));
  });

  void it("finds literal text in middle prompts, alternate branches, and nested sessions without non-text content", async () => {
    const result = await search({ term: ` ${term} `, cwd: "/fixture" });
    const records = matchRecords(result.text);
    assert.equal(result.isError, false);
    assert.partialDeepStrictEqual(result.details, { truncated: false });
    assert.equal(records.length, 3);
    const assistant = records.find((record) => record.includes('"entryId":"a1"'));
    assert(assistant);
    assert.partialDeepStrictEqual(JSON.parse(assistant), { file: parent, entryId: "a1", role: "assistant" });
    assert.match(assistant, /"snippet":"….*POSTGRES \[db\] decision.*…"/);
    assert(records.some((record) => record.includes('"entryId":"u2"')));
    assert(records.some((record) => record.includes(JSON.stringify(child))));
    assert.doesNotMatch(result.text, /private|tool output|command|generated summary/);
  });

  void it("lists IDs and reads a basic view by exact ID without prompts or per-call evidence", async () => {
    const list = await invoke("list_sessions", { cwd: "/usage" });
    assert.equal(list.isError, false);
    assert.match(list.text, /id: usage-session-id/);
    const result = await read({ sessionId: usageId });
    assert.equal(result.sessionId, usageId);
    assert.equal(result.file, usageFile);
    assert.equal(result.mode, "basic");
    assert.equal(result.metadata.timestamp, "2026-10-25T00:00:00.000Z");
    assert.deepStrictEqual(result.toolCounts, { bash: 3, read: 4, codemode: 1 });
    assert.deepStrictEqual(result.skillReadCounts, { "testing-practices": 1, "nested-skill": 1 });
    assert(!("references" in result));
    assert(!("userPrompts" in result));
    assert(!("branchSummaries" in result));
    assert.deepStrictEqual(await read({ path: usageFile }), result);
    const nested = await read({ sessionId: "usage-child-id" });
    assert.deepStrictEqual(nested.toolCounts, { bash: 1 });
  });

  void it("adds sparse navigation and only recorded timing in detailed mode", async () => {
    const result = await read({ sessionId: usageId, mode: "detailed" });
    assert(result.userPrompts.length > 0);
    assert.equal(result.toolErrors.length, 2);
    assert.equal(result.labels[0].label, "todo: inspect usage");
    assert.equal(result.branchSummaries[0].text, "Ignore bash /skill:summary");
    assert.equal(result.compactions[0].tokensBefore, 100);
    const top = result.references.find((ref: { callId?: string }) => ref.callId === "b1");
    assert.equal(top.timestamp, "2026-10-25T00:00:00.000Z");
    assert.equal(top.durationMs, 25);
    const nested = result.references.find((ref: { callId?: string }) => ref.callId === "wrapper/1");
    assert.equal(nested.timestamp, "2026-10-25T00:00:01.000Z");
    assert.equal(nested.durationMs, 12);
    const unknown = result.references.find((ref: { callId?: string }) => ref.callId === "lost");
    assert(!("durationMs" in unknown));
    assert.equal(unknown.status, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /private-source|private-output|git status/);
    const untimed = await read({ sessionId: "untimed-id", mode: "detailed", fields: ["tools"] });
    assert(!("timestamp" in untimed.references[0]));
    assert(!("durationMs" in untimed.references[0]));
  });

  void it("projects requested fields and limits evidence to the selected tools or skills scope", async () => {
    const tools = await usage({ fields: ["tools"], argument: "GIT STATUS" });
    assert.deepStrictEqual(tools.toolCounts, { bash: 2 });
    assert(!("metadata" in tools));
    assert(!("skillReadCounts" in tools));
    assert.equal(tools.matchedRecords, 2);
    const skills = await usage({ fields: ["skills"] });
    assert.deepStrictEqual(skills.skillReadCounts, { "testing-practices": 1, "nested-skill": 1 });
    assert(!("toolCounts" in skills));
    assert.equal(skills.matchedRecords, 3);
    assert(skills.references.every((ref: { skill?: string }) => ref.skill));
    const prompts = await read({ sessionId: usageId, fields: ["prompts"] });
    assert(prompts.userPrompts.length > 0);
    assert(!("toolCounts" in prompts));
    assert(!("metadata" in prompts));
  });

  for (const [params, error] of [
    [{}, /exactly one/],
    [{ sessionId: usageId, path: usageFile }, /exactly one/],
    [{ sessionId: "missing-id" }, /not found/],
    [{ sessionId: "ambiguous-id" }, /ambiguous/],
    [{ sessionId: usageId, fields: ["prompts"], tool: "bash" }, /require the tools or skills field/],
    [{ path: join(home, "outside.jsonl") }, /restricted/],
    [{ path: join(root, "escape.jsonl") }, /restricted/],
  ] as Array<[JsonObject, RegExp]>) {
    void it(`rejects invalid or unsafe session selection: ${JSON.stringify(params)}`, async () => {
      const result = await invoke("read_session", params);
      assert.equal(result.isError, true);
      assert.match(result.text, error);
      assert.doesNotMatch(result.text, /outside content must not leak/);
    });
  }

  void it("counts recorded calls, outcomes, successful skill reads, and user-supplied skill envelopes", async () => {
    const result = await usage();
    assert.deepStrictEqual(result.toolCounts, { bash: 3, read: 4, codemode: 1 });
    assert.deepStrictEqual(result.toolErrorCounts, { bash: 1, read: 1 });
    assert.deepStrictEqual(result.skillReadCounts, { "testing-practices": 1, "nested-skill": 1 });
    assert.deepStrictEqual(result.skillEnvelopeCounts, { "testing-practices": 1 });
    assert(result.references.some((ref: { kind: string; entryId?: string }) => ref.kind === "skill_envelope" && ref.entryId === "command"));
    assert.equal(result.incompleteNestedRecords, true);
    assert.equal(result.referencesTruncated, false);
    assert.equal(result.matchedRecords, 9);
    assert(result.references.some((ref: { callId?: string; status?: string }) => ref.callId === "lost" && ref.status === "unknown"));
    assert(result.references.some((ref: { callId?: string; nested?: boolean; entryId?: string }) => ref.callId === "wrapper/1" && ref.nested && ref.entryId === "nested"));
    assert.doesNotMatch(JSON.stringify(result), /private-source|private-output|git status|mentioned|failed/);
    for (const ref of result.references as Array<{ line: number; file: string; entryId: string }>) {
      const entry = JSON.parse(readFileSync(ref.file, "utf8").split("\n")[ref.line - 1]);
      assert.equal(entry.id, ref.entryId);
    }
  });

  void it("combines structured filters and keeps complete dictionaries with bounded references", async () => {
    const result = await usage({ tool: "bash", argument: "GIT STATUS", limit: 1 });
    assert.deepStrictEqual(result.toolCounts, { bash: 2 });
    assert.deepStrictEqual(result.toolErrorCounts, { bash: 1 });
    assert.equal(result.references.length, 1);
    assert.equal(result.matchedRecords, 2);
    assert.equal(result.referencesTruncated, true);
    const skill = await usage({ skill: "testing-practices" });
    assert.deepStrictEqual(skill.toolCounts, { read: 1 });
    assert.deepStrictEqual(skill.skillReadCounts, { "testing-practices": 1 });
    assert.deepStrictEqual(skill.skillEnvelopeCounts, { "testing-practices": 1 });
    const combined = await usage({ tool: "bash", skill: "testing-practices" });
    assert.deepStrictEqual(combined.toolCounts, {});
    assert.deepStrictEqual(combined.skillEnvelopeCounts, {});
    assert.equal(combined.matchedRecords, 0);
  });

  void it("preserves JSON dictionaries and source references within the output byte budget", async () => {
    const result = await usage({ sessionId: join(root, "usage-output.jsonl"), limit: 100 });
    assert.deepStrictEqual(result.toolCounts, JSON.parse('{"__proto__":100}'));
    assert.equal(result.matchedRecords, 100);
    assert.equal(result.referencesTruncated, true);
    assert(result.references.length > 0 && result.references.length < 100);
    assert(Buffer.byteLength(JSON.stringify(result, null, 2)) <= 50 * 1024);
  });

  for (const name of ["dictionary-bytes", "dictionary-lines"]) {
    void it(`rejects oversized ${name} rather than returning partial JSON or partial counts`, async () => {
      const result = await invoke("read_session", { sessionId: join(root, `${name}.jsonl`), mode: "usage" });
      assert.equal(result.isError, true);
      assert.match(result.text, /Session fields exceed the output budget/);
      const narrowed = await usage({ sessionId: join(root, `${name}.jsonl`), tool: name === "dictionary-bytes" ? `t0${"x".repeat(80)}` : "t0" });
      assert.equal(Object.values(narrowed.toolCounts)[0], 1);
    });
  }

  void it("reports no matches", async () => {
    const result = await search({ term: "missing-fixture-term" });
    assert.equal(result.isError, false);
    assert.deepStrictEqual(JSON.parse(result.text), { matchCount: 0, moreMatches: false });
    assert.partialDeepStrictEqual(result.details, { matches: [], truncated: false });
  });

  void it("rejects a whitespace-only term", async () => {
    const result = await search({ term: "   " });
    assert.equal(result.isError, true);
    assert.match(result.text, /Search term must contain text/);
  });

  for (const [cwd, moreMatches] of [["/limit", true], ["/exact", false]] as const) {
    void it(`reports ${moreMatches ? "omitted matches beyond" : "completion at"} the match limit`, async () => {
      const result = await search({ term, cwd });
      assert.equal(matchRecords(result.text).length, 20);
      assert.partialDeepStrictEqual(result.details, { truncated: moreMatches });
      assert.deepStrictEqual(JSON.parse(result.text.split("\n")[0]), { matchCount: 20, moreMatches });
    });
  }

  void it("preserves complete source records and snippets when output is truncated", async () => {
    const result = await search({ term: outputTerm, cwd: "/output" });
    assert.partialDeepStrictEqual(result.details, { truncated: true });
    assert.match(result.text, /Output truncated/);
    assert(Buffer.byteLength(result.text) < 51 * 1024);
    const records = matchRecords(result.text);
    assert(records.length > 0 && records.length < 20);
    for (const record of records) assert.doesNotThrow(() => JSON.parse(record));
    assert.partialDeepStrictEqual(JSON.parse(records[0]), { file: outputFile, entryId: "output-0", snippet: outputSnippet });
  });
});
