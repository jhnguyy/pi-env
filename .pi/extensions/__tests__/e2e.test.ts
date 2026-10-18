import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveNotesProvider } from "../notes/provider-registry";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundles = ["analyze", "web-context", "dev-tools", "notes", "skill-builder", "subagent"].map(
  (name) => join(repo, `.pi/extensions/${name}/dist/index.js`),
);

/** Real Pi session and built bundles, with a scripted provider and synthetic network response. */
describe("native tool workflows", () => {
  it("discovers tools and composes safe nested calls through a scripted provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-native-tools-"));
    const evidenceDir = process.env.PI_ENV_NATIVE_TOOL_ARTIFACT_DIR ?? tmpdir();
    mkdirSync(evidenceDir, { recursive: true });
    const artifact = join(mkdtempSync(join(evidenceDir, "pi-native-tools-")), "result.json");
    const evidence: Record<string, unknown> = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim().length > 0,
      repeat: "nub run build && nub run test:e2e:native-tools",
      input: {
        defaultTools: ["+codemode", "+tool_search"],
        query: "web fetch",
        limit: 1,
        notesVault: "temporary Obsidian vault",
        webFixture: "https://example.invalid/pi-env-fixture (synthetic response)",
        bundles: bundles.map((path) => path.slice(repo.length + 1)),
      },
      expected: {
        activeBefore: ["codemode", "tool_search", "closeout", "skill_build", "subagent", "notes"],
        callableBefore: ["analyze", "web_fetch", "notes"],
        notCallable: ["closeout", "skill_build", "subagent"],
        loaded: "web_fetch through model-issued search",
        webFetches: "synthetic result from deferred codemode and activated direct calls",
        composition: "nested read and Bash results combined with session context",
        bashFailure: "direct Bash reports an error; codemode receives structured exit_code 9",
        notes: "create and read a Wiki note in a temporary vault; reject an unguarded overwrite and release the provider",
      },
      actual: {},
      verdict: "failed",
    };
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    const previousCwd = process.cwd;
    // Notes discovers project settings from process.cwd(), not the SDK session cwd.
    process.cwd = () => workspace;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousTelemetry = process.env.PI_TELEMETRY;
    const previousFetch = globalThis.fetch;
    process.env.PI_CODING_AGENT_DIR = workspace;
    process.env.PI_TELEMETRY = "0";
    let fetchCount = 0;
    let phase = "initialization";
    let notesShutdown = false;
    try {
      evidence.bundleHashes = Object.fromEntries(bundles.map((path) => [path.slice(repo.length + 1), createHash("sha256").update(readFileSync(path)).digest("hex")]));
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode", "+tool_search"] });
      const faux = fauxProvider();
      const modelRuntime = await ModelRuntime.create({
        authPath: join(workspace, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      const vault = join(workspace, "vault");
      mkdirSync(vault);
      writeFileSync(join(workspace, "settings.json"), JSON.stringify({ notes: { provider: "obsidian", vaultPath: vault } }));
      const resourceLoader = new DefaultResourceLoader({
        cwd: workspace,
        agentDir: workspace,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: bundles,
        extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension()],
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd: workspace,
        agentDir: workspace,
        modelRuntime,
        model: faux.getModel(),
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.create(workspace, join(workspace, "sessions")),
      }));
      await session.bindExtensions({});
      phase = "registry";
      const activeBefore = session.getActiveToolNames();
      const callableBefore = session.getCallableToolNames();
      evidence.actual = { activeBefore, callableBefore };
      expect(activeBefore).toEqual(expect.arrayContaining(["codemode", "tool_search", "closeout", "skill_build", "subagent", "notes"]));
      expect(activeBefore).not.toContain("web_fetch");
      expect(callableBefore).toEqual(expect.arrayContaining(["analyze", "web_fetch", "notes"]));
      for (const name of ["tool_search", "closeout", "skill_build", "subagent"]) expect(callableBefore).not.toContain(name);

      const webUrl = "https://example.invalid/pi-env-fixture";
      globalThis.fetch = async (input) => {
        const requestedUrl = input instanceof Request ? input.url : String(input);
        if (requestedUrl !== webUrl) throw new Error(`Unexpected test fetch: ${requestedUrl}`);
        fetchCount += 1;
        return new Response("synthetic-web-fixture", { status: 200, headers: { "content-type": "text/plain" } });
      };
      const ordinaryPath = join(workspace, "ordinary.txt");
      writeFileSync(ordinaryPath, "ordinary-fixture");
      const sessionCommand = `printf 'session=%s' "$PI_SESSION_ID"`;
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", {
          code: `text(await tools.web_fetch({ url: ${JSON.stringify(webUrl)}, mode: "raw" }))`,
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("tool_search", { query: "web fetch", limit: 1 }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("web_fetch", { url: webUrl, mode: "raw" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("read", { path: ordinaryPath }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("codemode", {
          code: `const [file, shell] = await Promise.all([tools.read({ path: ${JSON.stringify(ordinaryPath)} }), tools.bash({ command: ${JSON.stringify(sessionCommand)} })]); text(JSON.stringify({ file, output: shell.output, exit_code: shell.exit_code }))`,
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("codemode", {
          code: `const status = await tools.bash({ command: "exit 9" }); if (status.exit_code !== 9) throw Error("wrong exit code"); text("nested-bash-exit:" + status.exit_code)`,
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("bash", { command: "exit 9" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("notes", { collection: "wiki", action: "write", target: "smoke.md", content: "# Smoke\n\nsynthetic-note", revision: null }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("notes", { collection: "wiki", action: "read", target: "smoke.md" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("notes", { collection: "wiki", action: "write", target: "smoke.md", content: "unguarded overwrite", revision: null }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      phase = "deferred codemode call";
      await session.prompt("Fetch the synthetic web fixture through codemode before discovery.");
      expect(session.getActiveToolNames()).not.toContain("web_fetch");
      expect(JSON.stringify(session.messages)).toContain("synthetic-web-fixture");
      phase = "model-issued tool search";
      await session.prompt("Search for the web fetch tool.");
      const activeAfter = session.getActiveToolNames();
      const searchResult = session.messages.find((message) => message.role === "toolResult" && message.toolName === "tool_search");
      const searchDetails = searchResult && "details" in searchResult ? searchResult.details : undefined;
      evidence.actual = { activeBefore, callableBefore, activeAfter, loaded: searchDetails };
      expect(searchDetails).toEqual({ loaded: ["web_fetch"] });
      expect(activeAfter).toContain("web_fetch");
      phase = "active direct web fetch";
      await session.prompt("Fetch the synthetic web fixture directly.");
      const directFetch = session.messages.find((message) => message.role === "toolResult" && message.toolName === "web_fetch");
      expect(JSON.stringify(directFetch)).toContain("synthetic-web-fixture");
      phase = "ordinary read";
      await session.prompt("Read the ordinary fixture directly.");
      phase = "nested tool composition";
      await session.prompt("Compose an ordinary read and session-aware Bash call in codemode.");
      const composedResult = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "codemode").at(-1);
      const composedText = JSON.stringify(composedResult);
      phase = "Bash nonzero exit contract";
      await session.prompt("Check the structured exit code from Bash in codemode.");
      const nestedBashResult = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "codemode").at(-1);
      await session.prompt("Run a failing Bash command directly.");
      const directBashResult = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "bash").at(-1);
      const notePath = join(vault, "wiki/smoke.md");
      phase = "notes creation";
      await session.prompt("Create a synthetic Wiki note in the temporary vault.");
      const noteCreated = existsSync(notePath);
      evidence.actual = { ...(evidence.actual as object), noteCreated };
      expect(noteCreated).toBe(true);
      phase = "notes read";
      await session.prompt("Read the synthetic Wiki note.");
      const noteRead = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "notes").at(-1);
      const noteReadReturnedContent = JSON.stringify(noteRead).includes("synthetic-note");
      evidence.actual = { ...(evidence.actual as object), noteReadReturnedContent };
      expect(noteReadReturnedContent).toBe(true);
      phase = "notes create-only conflict";
      await session.prompt("Attempt an unguarded overwrite of the synthetic Wiki note.");
      const noteConflict = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "notes").at(-1);
      const noteConflictIsError = !!noteConflict && "isError" in noteConflict && noteConflict.isError === true;
      const noteConflictSpecific = JSON.stringify(noteConflict).includes("Note changed since it was read: wiki/smoke.md");
      const noteContentPreserved = readFileSync(notePath, "utf8") === "# Smoke\n\nsynthetic-note";
      evidence.actual = { ...(evidence.actual as object), noteConflictIsError, noteConflictSpecific, noteContentPreserved };
      expect(noteConflictIsError && noteConflictSpecific && noteContentPreserved).toBe(true);
      const transcript = JSON.stringify(session.messages);
      evidence.actual = {
        activeBefore, callableBefore, activeAfter, loaded: searchDetails,
        webFetches: fetchCount,
        ordinaryRead: transcript.includes("ordinary-fixture"),
        nestedComposition: composedText.includes("ordinary-fixture") && composedText.includes(session.sessionManager.getSessionId()) && composedText.includes('"name":"bash"'),
        nestedBashExitCode: JSON.stringify(nestedBashResult).includes("nested-bash-exit:9") ? 9 : null,
        directBashIsError: !!directBashResult && "isError" in directBashResult && directBashResult.isError === true,
        directBashStatusVisible: JSON.stringify(directBashResult).includes("Command exited with code 9"),
        noteCreated,
        noteReadReturnedContent,
        noteConflictIsError,
        noteConflictSpecific,
        noteContentPreserved,
        fauxCalls: faux.state.callCount,
      };
      expect(evidence.actual).toEqual(expect.objectContaining({ webFetches: 2, ordinaryRead: true, nestedComposition: true, nestedBashExitCode: 9, directBashIsError: true, directBashStatusVisible: true, noteCreated: true, noteReadReturnedContent: true, noteConflictIsError: true, noteConflictSpecific: true, noteContentPreserved: true }));
      phase = "notes provider shutdown";
      writeFileSync(join(workspace, "settings.json"), "{}");
      await session.reload();
      notesShutdown = true;
      const notesUnregistered = !session.getActiveToolNames().includes("notes");
      let notesProviderUnregistered = false;
      try {
        resolveNotesProvider("obsidian");
      } catch (error) {
        notesProviderUnregistered = error instanceof Error && error.message === "Configured notes provider is not registered: obsidian";
      }
      evidence.actual = { ...(evidence.actual as object), notesUnregistered, notesProviderUnregistered };
      expect(notesUnregistered && notesProviderUnregistered).toBe(true);
      evidence.verdict = "passed";
    } catch (error) {
      evidence.failedPhase = phase;
      evidence.failureType = error instanceof Error ? error.name : "UnknownError";
      throw error;
    } finally {
      try {
        if (session && !notesShutdown) {
          writeFileSync(join(workspace, "settings.json"), "{}");
          await session.reload();
        }
      } finally {
        session?.dispose();
        process.cwd = previousCwd;
        globalThis.fetch = previousFetch;
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousTelemetry === undefined) delete process.env.PI_TELEMETRY;
        else process.env.PI_TELEMETRY = previousTelemetry;
        writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n");
        console.info(`Native tool evidence: ${artifact}`);
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  });
});

it("discovers session search and returns bounded text matches from real transcripts", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-session-search-"));
  const root = join(home, ".pi/agent/sessions/project");
  const evidenceRoot = process.env.PI_ENV_NATIVE_TOOL_ARTIFACT_DIR ?? tmpdir();
  mkdirSync(evidenceRoot, { recursive: true });
  const artifact = join(mkdtempSync(join(evidenceRoot, "pi-session-search-")), "result.json");
  const evidence = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    repeat: "nub run build && nub run test:e2e:native-tools",
    input: { term: "postgres [db]", fixtures: "parent, nested child, alternate branch, other cwd, and non-text content" },
    expected: { matches: 3, limitedMatches: 20, excluded: ["tool output", "thinking", "tool arguments", "summaries"] },
    actual: "", verdict: "failed",
  };
  try {
    mkdirSync(join(root, "_children/parent"), { recursive: true });
    const term = "postgres [db]";
    const message = (id: string, role: string, content: unknown) => ({ type: "message", id, parentId: "u1", message: { role, content } });
    const parent = join(root, "parent.jsonl");
    writeFileSync(parent, [
      { type: "session", id: "parent", cwd: "/fixture" },
      message("u1", "user", "First unrelated prompt"),
      message("a1", "assistant", [{ type: "text", text: `${"İ".repeat(200)}${"before ".repeat(30)}POSTGRES [db] decision${" after".repeat(30)}` }]),
      message("u2", "user", "Middle postgres [db] question"),
      message("a2", "assistant", [{ type: "thinking", thinking: `${term} private` }, { type: "toolCall", name: "bash", arguments: { command: `${term} command` } }]),
      message("t1", "toolResult", `${term} tool output`),
      { type: "compaction", summary: `${term} generated summary` },
      message("u3", "user", "Last unrelated prompt"),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\nnot json\n");
    writeFileSync(join(root, "_children/parent/child.jsonl"), [
      { type: "session", id: "child", cwd: "/fixture" }, message("child-u", "user", `${term} child`),
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    for (const [name, count] of [["limit", 21], ["exact", 20]] as const) {
      writeFileSync(join(root, `${name}.jsonl`), [
        { type: "session", id: name, cwd: `/${name}` },
        ...Array.from({ length: count }, (_, i) => message(`${name}-${i}`, "user", term)),
      ].map((entry) => JSON.stringify(entry)).join("\n"));
    }
    const longPath = join(root, ...Array<string>(8).fill("long-path".repeat(10)));
    mkdirSync(longPath, { recursive: true });
    writeFileSync(join(longPath, "output.jsonl"), [
      { type: "session", id: "output", cwd: "/output" },
      ...Array.from({ length: 20 }, (_, i) => message(`output-${i}`, "user", `${"\u0001".repeat(80)}${"\u0000".repeat(200)}${"\u0001".repeat(80)}`)),
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    // A subprocess gives native homedir() an isolated HOME without changing production path resolution.
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { createAgentSession, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
      import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["+tool_search"] });
      const faux = fauxProvider();
      const modelRuntime = await ModelRuntime.create({ authPath: process.env.HOME + "/auth.json", modelsPath: null, refreshOnCreate: false });
      modelRuntime.registerNativeProvider(faux.provider);
      const resourceLoader = new DefaultResourceLoader({ cwd: process.env.HOME, agentDir: process.env.HOME, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [${JSON.stringify(join(repo, ".pi/extensions/introspection/dist/index.js"))}], extensionFactories: [createToolSearchExtension()] });
      await resourceLoader.reload();
      const { session } = await createAgentSession({ cwd: process.env.HOME, agentDir: process.env.HOME, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(process.env.HOME) });
      try {
        await session.bindExtensions({});
        const deferred = !session.getActiveToolNames().includes("search_sessions");
        const calls = [["tool_search", { query: "search_sessions", limit: 1 }], ["search_sessions", { term: " postgres [db] ", cwd: "/fixture" }], ["search_sessions", { term: "postgres [db]", cwd: "/limit" }], ["search_sessions", { term: "missing-fixture-term" }], ["search_sessions", { term: "   " }], ["search_sessions", { term: "postgres [db]", cwd: "/exact" }], ["search_sessions", { term: "\\u0000".repeat(200), cwd: "/output" }]];
        faux.setResponses(calls.flatMap(([name, args]) => [fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }), fauxAssistantMessage("done")]));
        for (const [name] of calls) await session.prompt("Execute the next " + name + " fixture request.");
        console.log(JSON.stringify({ deferred, active: session.getActiveToolNames().includes("search_sessions"), results: session.messages.filter(m => m.role === "toolResult" && m.toolName === "search_sessions") }));
      } finally { await session.abort(); session.dispose(); }
    `], { cwd: repo, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_TELEMETRY: "0" }, encoding: "utf8", timeout: 25_000 });
    evidence.actual = output;
    const { deferred, active, results } = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(deferred && active).toBe(true);
    const [found, limited, missing, invalid, exact, bounded] = results;
    expect(found.details.matches).toHaveLength(3);
    expect(found.details.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: parent, entryId: "a1", role: "assistant", snippet: expect.stringMatching(/^….*POSTGRES \[db\] decision.*…$/) }),
    ]));
    expect(JSON.stringify(found)).not.toMatch(/private|tool output|command|generated summary/);
    expect(limited.details).toEqual(expect.objectContaining({ matches: Array.from({ length: 20 }, () => expect.any(Object)), truncated: true }));
    expect(missing.details).toEqual(expect.objectContaining({ matches: [], truncated: false }));
    expect(invalid.isError).toBe(true);
    expect(exact.details.truncated).toBe(false);
    expect(exact.details.matches).toHaveLength(20);
    expect(bounded.details.truncated).toBe(true);
    expect(bounded.content[0].text).toContain("Output truncated");
    expect(Buffer.byteLength(bounded.content[0].text)).toBeLessThan(51 * 1024);
    const retained = bounded.content[0].text.split("\n")
      .filter((line: string) => line.startsWith("{") && line.includes('"entryId":'))
      .map((line: string) => JSON.parse(line));
    expect(retained).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: join(longPath, "output.jsonl"), entryId: "output-0", snippet: expect.stringContaining("\u0000".repeat(200)) }),
    ]));
    expect(retained.length).toBeLessThan(20);
    evidence.verdict = "passed";
  } finally {
    writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n");
    console.info(`Session search evidence: ${artifact}`);
    rmSync(home, { recursive: true, force: true });
  }
});
