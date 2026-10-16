import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createToolSearchExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bundle = join(repo, ".pi/extensions/introspection/dist/index.js");

// A real Pi session discovers and calls the built tool. No model credentials or personal sessions are used.
describe("session text search workflow", () => {
  it("finds bounded source snippets across parent and child transcripts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-session-search-"));
    const evidenceRoot = process.env.PI_ENV_SEARCH_ARTIFACT_DIR ?? tmpdir();
    mkdirSync(evidenceRoot, { recursive: true });
    const artifact = join(mkdtempSync(join(evidenceRoot, "pi-session-search-")), "result.json");
    const evidence: Record<string, unknown> = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      bundleHash: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
      repeat: "nub run build && E2E=1 nub run test:vitest .pi/extensions/introspection/__tests__/e2e.test.ts",
      input: { term: "Postgres", fixture: "synthetic branched parent, nested child, other cwd, malformed JSON, and non-text content" },
      expected: { all: 4, parent: 3, child: 1, limited: 1, truncated: true, outputBudgetBytes: 40 * 1024, literalMatches: 1, unicodeOffsets: "snippet contains the original occurrence", ignored: ["toolResult", "thinking", "toolCall", "compaction", "symlinks"] },
      actual: {}, verdict: "failed",
    };
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(workspace, ".pi/agent");
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const root = join(workspace, ".pi/agent/sessions/project");
      const childDir = join(root, "_children/parent");
      mkdirSync(childDir, { recursive: true });
      const parent = join(root, "parent.jsonl");
      const child = join(childDir, "child.jsonl");
      const message = (id: string, parentId: string | null, role: string, content: unknown) => ({ type: "message", id, parentId, message: { role, content } });
      const entries = [
        { type: "session", id: "parent", cwd: "/fixture" },
        message("u1", null, "user", "Initial unrelated question"),
        message("a1", "u1", "assistant", [{ type: "text", text: `${"İ".repeat(200)}${"before ".repeat(30)}Postgres decision${" after".repeat(30)}` }]),
        message("u2", "a1", "user", "A middle POSTGRES question"),
        message("a2", "u2", "assistant", [{ type: "thinking", thinking: "postgres private" }, { type: "toolCall", name: "bash", arguments: { command: "postgres tool call" } }]),
        message("t1", "a2", "toolResult", "postgres tool output"),
        message("alternate", "u1", "assistant", "postgres alternative branch"),
        { type: "compaction", summary: "postgres generated summary" },
        message("u3", "alternate", "user", "Final unrelated question"),
      ];
      writeFileSync(parent, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\nnull\nnot json\n[]\n{"type":"message","message":null}\n`);
      writeFileSync(child, [
        { type: "session", id: "child", cwd: "/fixture", parentSession: parent },
        message("child-u", null, "user", [{ type: "text", text: "postgres child finding" }]),
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      writeFileSync(join(root, "other.jsonl"), [
        { type: "session", id: "other", cwd: "/elsewhere" },
        message("other-u", null, "user", "postgres outside cwd"),
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      const literalTerm = "[db].*+?";
      writeFileSync(join(root, "literal.jsonl"), [
        JSON.stringify({ type: "session", id: "literal", cwd: "/literal" }),
        JSON.stringify(message("literal-u", null, "user", `Use ${literalTerm} exactly`)),
        JSON.stringify(message("pattern-decoy", null, "user", "Use ddddd exactly")),
      ].join("\n"));
      const budgetTerm = "界".repeat(200);
      writeFileSync(join(root, "budget.jsonl"), [
        JSON.stringify({ type: "session", id: "budget", cwd: "/budget" }),
        ...Array.from({ length: 100 }, (_, i) => JSON.stringify(message(`budget-${i}`, null, "user", `${"前".repeat(80)}${budgetTerm}${"後".repeat(80)}`))),
      ].join("\n"));
      const outside = join(workspace, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "excluded.jsonl"), [
        JSON.stringify({ type: "session", id: "outside", cwd: "/fixture" }),
        JSON.stringify(message("outside-u", null, "user", "postgres outside session root")),
      ].join("\n"));
      symlinkSync(outside, join(root, "directory-link"), "dir");
      symlinkSync(join(outside, "excluded.jsonl"), join(root, "file-link.jsonl"));
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["+tool_search"] });
      const faux = fauxProvider();
      const modelRuntime = await ModelRuntime.create({ authPath: join(workspace, "auth.json"), modelsPath: null, refreshOnCreate: false });
      modelRuntime.registerNativeProvider(faux.provider);
      const resourceLoader = new DefaultResourceLoader({
        cwd: workspace, agentDir: workspace, settingsManager,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [bundle], extensionFactories: [createToolSearchExtension()],
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd: workspace, agentDir: workspace, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager,
        sessionManager: SessionManager.inMemory(workspace),
      }));
      await session.bindExtensions({});
      expect(session.getActiveToolNames()).not.toContain("search_sessions");
      const calls = [
        ["tool_search", { query: "search_sessions", limit: 1 }],
        ["search_sessions", { term: " Postgres ", cwd: "/fixture" }],
        ["search_sessions", { term: "postgres", cwd: "/fixture", scope: "parent" }],
        ["search_sessions", { term: "postgres", cwd: "/fixture", scope: "child" }],
        ["search_sessions", { term: "postgres", cwd: "/fixture", limit: 1 }],
        ["search_sessions", { term: "absent-fixture-term" }],
        ["search_sessions", { term: "   " }],
        ["search_sessions", { term: budgetTerm, cwd: "/budget", limit: 100 }],
        ["search_sessions", { term: "postgres", cwd: "/fixture", scope: "parent", limit: 3 }],
        ["search_sessions", { term: literalTerm, cwd: "/literal" }],
      ] as const;
      faux.setResponses(calls.flatMap(([name, args]) => [
        fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }), fauxAssistantMessage("done"),
      ]));
      for (const [name] of calls) await session.prompt(`Execute the next ${name} fixture request.`);
      const results = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "search_sessions");
      evidence.actual = results;
      expect(session.getActiveToolNames()).toContain("search_sessions");
      const details = results.map((result) => "details" in result ? result.details : undefined);
      expect(details[0]).toEqual(expect.objectContaining({ matches: expect.any(Array), truncated: false, cancelled: false }));
      expect(details[0]).toEqual(expect.objectContaining({ matches: Array.from({ length: 4 }, () => expect.any(Object)) }));
      expect(details[1]).toEqual(expect.objectContaining({ matches: Array.from({ length: 3 }, () => expect.any(Object)) }));
      expect(details[2]).toEqual(expect.objectContaining({ matches: [expect.objectContaining({ file: child, sessionId: "child", entryId: "child-u", parentId: null, role: "user", line: 2 })] }));
      expect(details[3]).toEqual(expect.objectContaining({ truncated: true, matches: [expect.any(Object)] }));
      expect(details[4]).toEqual(expect.objectContaining({ matches: [], truncated: false }));
      expect(results[5]).toEqual(expect.objectContaining({ isError: true }));
      expect(details[6]).toEqual(expect.objectContaining({ truncated: true }));
      expect(Buffer.byteLength(JSON.stringify(details[6]))).toBeLessThan(42 * 1024);
      expect(details[7]).toEqual(expect.objectContaining({ truncated: false, matches: Array.from({ length: 3 }, () => expect.any(Object)) }));
      expect(details[0]).toEqual(expect.objectContaining({ matches: expect.arrayContaining([
        expect.objectContaining({ file: parent, sessionId: "parent", entryId: "a1", parentId: "u1", line: 3, role: "assistant", snippet: expect.stringMatching(/^….*Postgres decision.*…$/) }),
      ]) }));
      expect(details[8]).toEqual(expect.objectContaining({ truncated: false, matches: [expect.objectContaining({ entryId: "literal-u", snippet: `Use ${literalTerm} exactly` })] }));
      expect(JSON.stringify(results[0])).not.toMatch(/postgres (private|tool output|tool call|generated summary)/);
      evidence.verdict = "passed";
    } finally {
      if (session) { await session.abort(); session.dispose(); }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`Session search evidence: ${artifact}`);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
