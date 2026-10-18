import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const home = homedir();
const root = join(home, ".pi/agent/sessions/project");
const parent = join(root, "parent.jsonl");
const child = join(root, "_children/parent/child.jsonl");
const outputFile = join(root, ...Array<string>(8).fill("long-path".repeat(10)), "output.jsonl");
const term = "postgres [db]";
const outputTerm = "\u0000".repeat(200);
const outputSnippet = `${"\u0001".repeat(80)}${outputTerm}${"\u0001".repeat(80)}`;
const faux = fauxProvider();
let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
let wasDeferred = false;

function message(id: string, role: string, content: unknown, parentId: string | null = "u1") {
  return { type: "message", id, parentId, message: { role, content } };
}

function writeTranscript(file: string, cwd: string, entries: object[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    { type: "session", id: file, cwd }, ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\nnot json\n");
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
}

async function search(params: { term: string; cwd?: string }) {
  const start = session.messages.length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_sessions", params), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("Execute the session search fixture request.");
  const result = session.messages.slice(start).find((entry) => entry.role === "toolResult" && entry.toolName === "search_sessions");
  assert(result?.role === "toolResult", "search_sessions must return a tool result for this request");
  return {
    text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    isError: result.isError,
    details: result.details,
  };
}

function matchRecords(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("{") && line.includes('"entryId":'));
}

// node:test owns completion and reports failed callbacks through the process exit status.
void describe("session search public workflow", { concurrency: false }, () => {
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
  });

  after(async () => {
    await session?.abort();
    session?.dispose();
  });

  void it("discovers the deferred tool", () => {
    assert(wasDeferred);
    assert(session.getActiveToolNames().includes("search_sessions"));
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
