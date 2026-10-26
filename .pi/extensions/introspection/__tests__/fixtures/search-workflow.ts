import assert from "node:assert/strict";
import { Type } from "typebox";
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
let parent: string;
let child: string;
let usageFile: string;
let usageId: string;
let usageChildId: string;
let largeErrorId: string;
let usageTimestamp: string;
let assistantEntryId: string;
let middleEntryId: string;
let envelopeEntryId: string;
const fixtureCwd = join(home, "fixture");
const usageCwd = join(home, "usage");
const skillPath = (name: string) => join(home, "skills", name, "SKILL.md");
let outputFile: string;
let outputEntryId: string;
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

function createSyntheticTranscripts(): void {
  // Keep malformed, missing-result, exact-clock, and oversized inputs separate from native workflows.
  writeTranscript(join(root, "legacy-usage.jsonl"), "/legacy-usage", [
    message("legacy-prompt", "user", "Legacy postgres [db] note", null),
    message("calls", "assistant", [
      { type: "toolCall", id: "b1", name: "bash", arguments: { command: "git status" } },
      { type: "toolCall", id: "lost", name: "bash", arguments: { command: "not completed" } },
      { type: "toolCall", id: "wrapper", name: "codemode", arguments: { code: "private-source" } },
    ]),
    { type: "message", id: "result-b1", message: { role: "toolResult", toolCallId: "b1", toolName: "bash", isError: true, durationMs: 25, content: [{ type: "text", text: "private-output" }] } },
    { type: "message", id: "nested", timestamp: "2026-10-25T00:00:01.000Z", message: { role: "toolResult", toolCallId: "wrapper", toolName: "codemode", isError: false, nestedCalls: { complete: false, calls: [
      { id: "wrapper/1", name: "bash", arguments: { command: "git status --short" }, status: "ok", durationMs: 12 },
      { id: "wrapper/2", name: "read", argumentsBytes: 10000, status: "ok" },
    ] } } },
  ], "legacy-usage-id");
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
  writeTranscript(join(root, "long-header.jsonl"), `/${"λ".repeat(8000)}`, [], "long-header-id");
  writeFileSync(join(root, "short-header.jsonl"), JSON.stringify({ type: "session", id: "short-header-id", cwd: "/short" }));
  for (const [id, size] of [["boundary-header-id", 65536], ["oversized-header-id", 65537]] as const) {
    const header = { type: "session", id, cwd: "/boundary", padding: "" };
    header.padding = "x".repeat(size - Buffer.byteLength(JSON.stringify(header)));
    const text = JSON.stringify(header);
    assert.equal(Buffer.byteLength(text), size);
    writeFileSync(join(root, `${id}.jsonl`), `${text}\n`);
  }
  writeFileSync(join(root, "empty.jsonl"), "");
  writeFileSync(join(root, "broken-header.jsonl"), '{"type":');
  writeFileSync(join(home, "outside.jsonl"), "outside content must not leak");
  symlinkSync(join(home, "outside.jsonl"), join(root, "escape.jsonl"));
}

async function createNativeTranscripts(): Promise<void> {
  for (const cwd of [fixtureCwd, usageCwd]) mkdirSync(cwd, { recursive: true });
  for (const name of ["testing-practices", "nested-skill"]) {
    mkdirSync(dirname(skillPath(name)), { recursive: true });
    writeFileSync(skillPath(name), `---\nname: ${name}\ndescription: Synthetic instructions for the session workflow.\n---\nprivate-skill-instructions\n`);
  }
  const provider = fauxProvider();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, "generation-auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider.provider);

  async function generate(manager: SessionManager, run: (generated: typeof session) => Promise<void>) {
    const cwd = manager.getHeader()!.cwd;
    const loader = new DefaultResourceLoader({
      cwd, agentDir: join(home, "generation-agent"), settingsManager,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalSkillPaths: [join(home, "skills")],
      extensionFactories: [(pi) => {
        // Control the external command boundary. Pi owns execution and recording.
        pi.registerTool({
          name: "bash", label: "Controlled Bash", description: "Synthetic command service.",
          parameters: Type.Object({ command: Type.String() }),
          async execute(_id, args) {
            if (args.command === "large failure") throw new Error(`private-large-output ${"synthetic error ".repeat(10000)}`);
            if (args.command.includes("fail")) throw new Error("private-output: synthetic external failure");
            return { content: [{ type: "text", text: `${term} tool output private-output` }], details: undefined };
          },
        });
        pi.registerTool({
          name: "codemode", label: "Controlled composition", description: "Run the fixture's nested tools.",
          parameters: Type.Object({ code: Type.String() }),
          async execute(_id, _args, _signal, _update, ctx) {
            assert.equal((await ctx.executeTool("bash", { command: "git status --short" })).isError, false);
            assert.equal((await ctx.executeTool("read", { path: skillPath("nested-skill") })).isError, false);
            return { content: [{ type: "text", text: "private-output" }], details: undefined };
          },
        });
      }],
    });
    await loader.reload();
    assert.deepStrictEqual(loader.getExtensions().errors, []);
    assert.deepStrictEqual(loader.getSkills().skills.map((skill) => skill.name).sort(), ["nested-skill", "testing-practices"]);
    const { session: generated } = await createAgentSession({
      cwd, agentDir: join(home, "generation-agent"), modelRuntime, model: provider.getModel(),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ["read", "bash", "codemode"],
    });
    try {
      await generated.bindExtensions({});
      generated.setActiveToolsByName(["read", "bash", "codemode"]);
      await run(generated);
    } finally {
      generated.dispose();
    }
  }
  async function say(generated: typeof session, prompt: string, response = "done") {
    provider.setResponses([fauxAssistantMessage(response)]);
    await generated.prompt(prompt);
  }
  async function call(generated: typeof session, name: string, args: JsonObject, prompt = "Execute the controlled workflow.") {
    const start = generated.messages.length;
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await generated.prompt(prompt);
    const result = generated.messages.slice(start).find((entry) => entry.role === "toolResult" && entry.toolName === name);
    assert(result?.role === "toolResult");
    return result;
  }
  const parentManager = SessionManager.create(fixtureCwd, root);
  parent = parentManager.getSessionFile()!;
  await generate(parentManager, async (generated) => {
    await say(generated, "First unrelated prompt", `${"İ".repeat(200)}${"before ".repeat(30)}POSTGRES [db] decision${" after".repeat(30)}`);
    assistantEntryId = parentManager.getLeafId()!;
    provider.setResponses([
      fauxAssistantMessage([
        { type: "thinking", thinking: `${term} private` },
        fauxToolCall("bash", { command: `${term} command` }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await generated.prompt("Middle postgres [db] question");
    assert(generated.messages.some((entry) => entry.role === "toolResult" && !entry.isError));
    const middle = parentManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Middle postgres [db] question"));
    assert(middle);
    middleEntryId = middle.id;
    parentManager.branchWithSummary(assistantEntryId, `${term} generated summary`);
    await say(generated, "Last unrelated prompt");
    parentManager.appendCompaction(`${term} generated summary`, null, 100);
  });
  const childManager = SessionManager.create(fixtureCwd, join(root, "_children", parentManager.getSessionId()), { parentSession: parent });
  child = childManager.getSessionFile()!;
  await generate(childManager, (generated) => say(generated, `${term} child`));

  const usageManager = SessionManager.create(usageCwd, root);
  usageFile = usageManager.getSessionFile()!;
  usageId = usageManager.getSessionId();
  usageTimestamp = usageManager.getHeader()!.timestamp;
  await generate(usageManager, async (generated) => {
    await say(generated, "bash read /skill:testing-practices /skills/mentioned/SKILL.md");
    await say(generated, "/skill:testing-practices");
    const envelope = usageManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("<skill name="));
    assert(envelope, "native /skill command must persist its expanded envelope");
    envelopeEntryId = envelope.id;
    const failedCommand = await call(generated, "bash", { command: "git status fail" });
    assert.equal(failedCommand.isError, true);
    assert.match(JSON.stringify(failedCommand.content), /synthetic external failure/);
    assert.equal((await call(generated, "read", { path: skillPath("testing-practices") })).isError, false);
    assert.equal((await call(generated, "read", { path: skillPath("failed") })).isError, true);
    assert.equal((await call(generated, "codemode", { code: "private-source" })).isError, false);
    const leaf = usageManager.getLeafId()!;
    usageManager.appendLabelChange(leaf, "todo: inspect usage");
    usageManager.branchWithSummary(leaf, "Ignore bash /skill:summary");
    usageManager.appendCompaction("Compact usage history", null, 100);
    usageManager.appendSessionInfo("Native usage workflow");
  });
  const usageChild = SessionManager.create(usageCwd, join(root, "_children", usageId), { parentSession: usageFile });
  usageChildId = usageChild.getSessionId();
  await generate(usageChild, async (generated) => {
    assert.equal((await call(generated, "bash", { command: "git status" })).isError, false);
  });
  utimesSync(usageFile, 1000, 1000);
  utimesSync(usageChild.getSessionFile()!, 2000, 2000);
  const largeErrorManager = SessionManager.create(join(home, "large-errors"), root);
  largeErrorId = largeErrorManager.getSessionId();
  await generate(largeErrorManager, async (generated) => {
    assert.equal((await call(generated, "bash", { command: "large failure" })).isError, true);
  });
  for (const [name, count] of [["limit", 21], ["exact", 20]] as const) {
    const manager = SessionManager.create(join(home, name), root);
    await generate(manager, async (generated) => {
      for (let i = 0; i < count; i++) await say(generated, term);
    });
  }
  const outputManager = SessionManager.create(join(home, "output"), join(root, ...Array<string>(8).fill("long-path".repeat(10))));
  outputFile = outputManager.getSessionFile()!;
  await generate(outputManager, async (generated) => {
    for (let i = 0; i < 20; i++) await say(generated, outputSnippet);
    const firstPrompt = outputManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
    assert(firstPrompt);
    outputEntryId = firstPrompt.id;
  });
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
    await createNativeTranscripts();
    createSyntheticTranscripts();
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
    const result = await search({ term: ` ${term} `, cwd: fixtureCwd });
    const records = matchRecords(result.text);
    assert.equal(result.isError, false);
    assert.partialDeepStrictEqual(result.details, { truncated: false });
    assert.equal(records.length, 3);
    const assistant = records.find((record) => JSON.parse(record).entryId === assistantEntryId);
    assert(assistant);
    assert.partialDeepStrictEqual(JSON.parse(assistant), { file: parent, entryId: assistantEntryId, role: "assistant" });
    assert.match(assistant, /"snippet":"….*POSTGRES \[db\] decision.*…"/);
    assert(records.some((record) => JSON.parse(record).entryId === middleEntryId));
    assert(records.some((record) => record.includes(JSON.stringify(child))));
    assert.doesNotMatch(result.text, /private|tool output|command|generated summary/);
  });

  void it("lists IDs and reads a basic view by exact ID without prompts or per-call evidence", async () => {
    const list = await invoke("list_sessions", { cwd: usageCwd });
    assert.equal(list.isError, false);
    assert(list.text.includes(`id: ${usageId}`));
    assert(list.text.includes(`id: ${usageChildId}`));
    assert(list.text.indexOf(`id: ${usageChildId}`) < list.text.indexOf(`id: ${usageId}`));
    const result = await read({ sessionId: usageId });
    assert.equal(result.sessionId, usageId);
    assert.equal(result.file, usageFile);
    assert.equal(result.mode, "basic");
    assert.equal(result.metadata.timestamp, usageTimestamp);
    assert.deepStrictEqual(result.toolCounts, { bash: 2, read: 3, codemode: 1 });
    assert.deepStrictEqual(result.skillReadCounts, { "testing-practices": 1, "nested-skill": 1 });
    assert(!("references" in result));
    assert(!("userPrompts" in result));
    assert(!("branchSummaries" in result));
    assert.deepStrictEqual(await read({ path: usageFile }), result);
    const nested = await read({ sessionId: usageChildId });
    assert.deepStrictEqual(nested.toolCounts, { bash: 1 });
  });

  void it("finds IDs across different header sizes, missing newlines, and corrupt unrelated headers", async () => {
    for (const sessionId of ["long-header-id", "short-header-id", "boundary-header-id"]) {
      const result = await read({ sessionId, fields: ["tools"] });
      assert.equal(result.sessionId, sessionId);
      assert.deepStrictEqual(result.toolCounts, {});
    }
    const oversized = await invoke("read_session", { sessionId: "oversized-header-id" });
    assert.equal(oversized.isError, true);
    assert.match(oversized.text, /not found/);
  });

  void it("returns only error locations for large failed tool outputs", async () => {
    const result = await read({ sessionId: largeErrorId, fields: ["errors"] });
    assert.equal(result.toolErrors.length, 1);
    assert.equal(result.toolErrors[0].toolName, "bash");
    assert(result.toolErrors[0].line > 0);
    assert(!("text" in result.toolErrors[0]));
    assert.doesNotMatch(JSON.stringify(result), /private-large-output|synthetic error/);
  });

  void it("adds sparse navigation and only recorded timing in detailed mode", async () => {
    const result = await read({ sessionId: usageId, mode: "detailed" });
    assert(result.userPrompts.length > 0);
    assert.equal(result.toolErrors.length, 2);
    assert.equal(result.labels[0].label, "todo: inspect usage");
    assert.equal(result.branchSummaries[0].text, "Ignore bash /skill:summary");
    assert.equal(result.compactions[0].tokensBefore, 100);
    const nested = result.references.find((ref: { nested?: boolean; tool?: string }) => ref.nested && ref.tool === "bash");
    assert(nested);
    assert(Number.isFinite(Date.parse(nested.timestamp)));
    assert(nested.durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(result), /private-source|private-output|git status/);
    const untimed = await read({ sessionId: "untimed-id", mode: "detailed", fields: ["tools"] });
    assert(!("timestamp" in untimed.references[0]));
    assert(!("durationMs" in untimed.references[0]));
  });

  void it("retains legacy missing-result, bounded nested-record, and exact timing compatibility", async () => {
    const result = await read({ sessionId: "legacy-usage-id", mode: "usage" });
    assert.deepStrictEqual(result.toolCounts, { bash: 3, read: 1, codemode: 1 });
    assert.equal(result.incompleteNestedRecords, true);
    const top = result.references.find((ref: { callId?: string }) => ref.callId === "b1");
    assert.equal(top.timestamp, "2026-10-25T00:00:00.000Z");
    assert.equal(top.durationMs, 25);
    const nested = result.references.find((ref: { callId?: string }) => ref.callId === "wrapper/1");
    assert.equal(nested.timestamp, "2026-10-25T00:00:01.000Z");
    assert.equal(nested.durationMs, 12);
    const unknown = result.references.find((ref: { callId?: string }) => ref.callId === "lost");
    assert.equal(unknown.status, "unknown");
    assert(!("durationMs" in unknown));
    assert.doesNotMatch(JSON.stringify(result), /private-source|private-output|git status/);
    for (const ref of result.references as Array<{ line: number; file: string; entryId: string }>) {
      const entry = JSON.parse(readFileSync(ref.file, "utf8").split("\n")[ref.line - 1]);
      assert.equal(entry.id, ref.entryId);
    }
    const searchResult = await search({ term, cwd: "/legacy-usage" });
    assert.equal(searchResult.isError, false);
    const records = matchRecords(searchResult.text).map((record) => JSON.parse(record));
    assert.equal(records.length, 1);
    assert.equal(records[0].entryId, "legacy-prompt");
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
    [{ sessionId: "any-id", path: join(root, "any.jsonl") }, /exactly one/],
    [{ sessionId: "missing-id" }, /not found/],
    [{ sessionId: "ambiguous-id" }, /ambiguous/],
    [{ sessionId: "legacy-usage-id", fields: ["prompts"], tool: "bash" }, /require the tools or skills field/],
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
    assert.deepStrictEqual(result.toolCounts, { bash: 2, read: 3, codemode: 1 });
    assert.deepStrictEqual(result.toolErrorCounts, { bash: 1, read: 1 });
    assert.deepStrictEqual(result.skillReadCounts, { "testing-practices": 1, "nested-skill": 1 });
    assert.deepStrictEqual(result.skillEnvelopeCounts, { "testing-practices": 1 });
    assert(result.references.some((ref: { kind: string; entryId?: string }) => ref.kind === "skill_envelope" && ref.entryId === envelopeEntryId));
    assert.equal(result.incompleteNestedRecords, false);
    assert.equal(result.referencesTruncated, false);
    assert.equal(result.matchedRecords, 7);
    assert(result.references.some((ref: { nested?: boolean }) => ref.nested));
    assert.doesNotMatch(JSON.stringify(result), /private-source|private-output|private-skill-instructions|git status|mentioned|failed/);
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
      const result = await search({ term, cwd: join(home, cwd.slice(1)) });
      assert.equal(matchRecords(result.text).length, 20);
      assert.partialDeepStrictEqual(result.details, { truncated: moreMatches });
      assert.deepStrictEqual(JSON.parse(result.text.split("\n")[0]), { matchCount: 20, moreMatches });
    });
  }

  void it("preserves complete source records and snippets when output is truncated", async () => {
    const result = await search({ term: outputTerm, cwd: join(home, "output") });
    assert.partialDeepStrictEqual(result.details, { truncated: true });
    assert.match(result.text, /Output truncated/);
    assert(Buffer.byteLength(result.text) < 51 * 1024);
    const records = matchRecords(result.text);
    assert(records.length > 0 && records.length < 20);
    for (const record of records) assert.doesNotThrow(() => JSON.parse(record));
    assert.partialDeepStrictEqual(JSON.parse(records[0]), { file: outputFile, entryId: outputEntryId, snippet: outputSnippet });
  });
});
