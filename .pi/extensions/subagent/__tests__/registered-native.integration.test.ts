import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import initSubagent from "../index";
import * as Control from "../control";
import type * as Browser from "../browser";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import * as Tooling from "../../../../src/telemetry/tooling";

// Only terminal I/O, inference and the telemetry collector are substituted.
// Registered tools, browser input, native children and persisted files are real.
it("runs and resumes retained children through registered tools and direct browser input", async () => {
  const root = await mkdtemp(join(tmpdir(), "registered-native-"));
  const agentDir = join(root, "agent");
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  let browser: Browser.SubagentBrowser | undefined;
  let unsubscribeUpdates: (() => void) | undefined;
  const spans: ReadableSpan[] = [];
  const updates: { toolCallId: string; content: string }[] = [];
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await mkdir(agentDir);
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "browser-child": { apiKey: "fixture-key" } } }));
    const extension = join(root, ".pi", "provider.mjs");
    await writeFile(extension, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { existsSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
export default function(pi) {
 const p = fauxProvider({provider:'browser-child'});
 let gates = 0;
 pi.registerProvider({...p.provider,
   stream(...args) { pi.appendEntry('fixture-provider-request',{}); return p.provider.stream(...args); },
   streamSimple(...args) { pi.appendEntry('fixture-provider-request',{}); return p.provider.streamSimple(...args); }
 });
 pi.registerTool({name:'fixture_gate',label:'Gate',description:'Wait for a test-owned file or abort',parameters:{type:'object',properties:{},additionalProperties:false},async execute(_id,_params,signal) {
   const number = ++gates;
   writeFileSync(root+'/entered-'+number,'entered');
   while (!existsSync(root+'/release-'+number) && !signal?.aborted) await new Promise(resolve=>setTimeout(resolve,5));
   return {content:[{type:'text',text:'gate settled'}],details:{}};
 }});
 pi.on('input', event => {
   pi.appendEntry('native-input-hook',{text:event.text,source:event.source});
   if(event.text === 'Human handled') return {action:'handled'};
   if(event.text === 'root seed') p.setResponses([
     fauxAssistantMessage(fauxToolCall('subagent',{action:'run',name:'sync',task:'Sync task\\nexact original',tools:['read'],system_prompt:'Explicit delegated instruction'}),{stopReason:'toolUse'}),
     fauxAssistantMessage(fauxToolCall('subagent',{action:'start',name:'async',task:'Async task\\nexact original',tools:['fixture_gate']}),{stopReason:'toolUse'}),
     fauxAssistantMessage('Parent ready')]);
   if(event.text === 'Sync task\\nexact original') p.setResponses([fauxAssistantMessage(fauxToolCall('read',{path:'identity.txt'}),{stopReason:'toolUse'}),fauxAssistantMessage('sync initial complete')]);
   if(event.text === 'Async task\\nexact original') p.setResponses([fauxAssistantMessage(fauxToolCall('fixture_gate',{}),{stopReason:'toolUse'}),fauxAssistantMessage('async initial complete'),fauxAssistantMessage('follow-up complete'),fauxAssistantMessage('idle human complete')]);
   if(event.text === 'next gated turn' || event.text === 'exit while running') p.setResponses([fauxAssistantMessage(fauxToolCall('fixture_gate',{}),{stopReason:'toolUse'}),fauxAssistantMessage('gated turn settled')]);
 });
}`);
    await writeFile(join(root, "identity.txt"), "target identity");
    await writeFile(join(root, "AGENTS.md"), "Native target context for browser inspection");
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "browser-child", defaultModel: "faux-1", defaultTools: ["read"] }));
    const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }), resourceLoaderReloadOptions: { resolveProjectTrust: async () => true }, resourceLoaderOptions: { extensionFactories: [(pi) => initSubagent(pi, {
      telemetryRuntimeFactory: () => Tooling.createToolingTelemetryRuntime({
        serviceName: "registered-native", env: { PI_ENV_TOOLING_OTEL_ENABLED: "true", PI_ENV_TOOLING_OTEL_ENDPOINT: "http://collector:4318" },
        exporter: { export: (finished, callback) => { spans.push(...finished); callback({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
      }),
    })] } });
    parent = (await createAgentSessionFromServices({ services, tools: ["read", "subagent"], sessionManager: SessionManager.create(root, join(root, "sessions")) })).session;
    unsubscribeUpdates = parent.subscribe((event) => {
      if (event.type === "tool_execution_update" && event.toolName === "subagent") updates.push({ toolCallId: event.toolCallId, content: JSON.stringify(event.partialResult.content) });
    });
    const originalDraft = "Keep this parent draft";
    let draft = originalDraft;
    let overlayHidden = false;
    const editorInputs: (string | undefined)[] = [];
    // The terminal/editor transport is the substituted boundary; the CLI smoke
    // exercises native editor focus and draft restoration in both terminal modes.
    const ui = {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setWidget: vi.fn(), notify: vi.fn(), getEditorText: () => draft, setEditorText: (text: string) => { draft = text; },
      editor: async (title: string) => {
        expect(overlayHidden).toBe(true);
        const savedDraft = draft;
        draft = title;
        try { return editorInputs.shift(); } finally { draft = savedDraft; }
      },
      custom: (factory: any, options: any) => new Promise<void>((resolve) => {
        browser = factory({ terminal: { rows: 60 }, requestRender: vi.fn() }, ui.theme, {}, resolve);
        options.onHandle({ setHidden: (hidden: boolean) => { overlayHidden = hidden; } });
      }),
    };
    await parent.bindExtensions({ mode: "tui", uiContext: ui as any });
    await parent.prompt("root seed");
    expect(parent.messages.flatMap((message) => message.role === "system" ? [] : [message.role])).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"]);
    expect(parent.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ text: "Parent ready" })]) }));
    await vi.waitFor(() => expect(existsSync(join(root, "entered-1"))).toBe(true));
    const supervisor = Control.getSubagentRunSupervisor(parent.sessionId)!;
    expect(supervisor.children.size).toBe(2);
    const asyncChild = [...supervisor.children.values()].find((child) => child.summary().name === "async")!;
    const syncChild = [...supervisor.children.values()].find((child) => child.summary().name === "sync")!;
    expect(syncChild.inspect().initialResult?.finalOutput).toBe("sync initial complete");
    expect(syncChild.inspect().messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolName: "read", content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("target identity") })]),
    }));
    const syncResult = parent.messages.filter((message) => message.role === "toolResult").find((message) => message.toolName === "subagent");
    if (!syncResult) throw new Error("Missing synchronous subagent tool result");
    expect(syncChild.inspect().initialResult).toEqual(syncResult.details);
    expect(parent.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName)).toEqual(["subagent", "subagent"]);
    expect(updates.flatMap((update) => update.toolCallId === syncResult.toolCallId ? [update.content] : []).join("\n")).toContain("sync initial complete");
    const parentBefore = { messages: structuredClone(parent.messages), model: parent.model, tools: parent.getActiveToolNames(), id: parent.sessionId };
    const interaction = parent.prompt("/subagents");
    await vi.waitFor(() => expect(browser).toBeDefined());
    expect(browser!.render(160).join("\n")).toContain("2 retained sessions");
    browser!.handleInput("\u001b[B");
    browser!.handleInput("\r");
    browser!.handleInput("\t");
    expect(browser!.render(160).join("\n")).toContain("Native target context for browser inspection");
    editorInputs.push("Human steering\nverbatim");
    browser!.handleInput("s");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("Steering queued for native processing."));
    editorInputs.push("Human follow-up\nverbatim");
    browser!.handleInput("f");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("Follow-up queued for native processing."));
    await vi.waitFor(() => expect(asyncChild.inspect().inputs).toHaveLength(3));
    await writeFile(join(root, "release-1"), "release");
    await vi.waitFor(() => expect(asyncChild.inspect().initialResult).toBeDefined());
    const initial = asyncChild.inspect().initialResult!;
    expect(initial.isError).toBe(false);
    await vi.waitFor(() => expect(asyncChild.summary().state).toBe("idle"));
    editorInputs.push("Human idle\nverbatim");
    browser!.handleInput("p");
    const file = asyncChild.summary().sessionFile!;
    await vi.waitFor(async () => expect(await readFile(file, "utf8")).toContain("idle human complete"));
    await vi.waitFor(() => expect(asyncChild.summary().state).toBe("idle"));
    const beforeHandled = asyncChild.inspect().messages.filter((message) => message.role === "assistant");
    const countRequests = () => SessionManager.open(file).getEntries().filter((entry) => entry.type === "custom" && entry.customType === "fixture-provider-request").length;
    const requestsBeforeHandled = countRequests();
    expect(requestsBeforeHandled).toBeGreaterThan(0);
    editorInputs.push("Human handled");
    browser!.handleInput("p");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("Handled by a child input hook; no model turn started."));
    expect(asyncChild.inspect().messages.filter((message) => message.role === "assistant")).toEqual(beforeHandled);
    expect(countRequests()).toBe(requestsBeforeHandled);
    const reopened = SessionManager.open(file);
    expect(reopened.buildSessionContext().messages).toEqual(asyncChild.inspect().messages);
    const entries = reopened.getEntries();
    const provenance = entries.filter((entry) => entry.type === "custom" && entry.customType === "subagent-input").map((entry: any) => entry.data);
    expect(provenance.map((input) => [input.source, input.mode, input.text])).toEqual([
      ["coordinator", "prompt", "Async task\nexact original"],
      ["human", "steer", "Human steering\nverbatim"],
      ["human", "followUp", "Human follow-up\nverbatim"],
      ["human", "prompt", "Human idle\nverbatim"],
      ["human", "prompt", "Human handled"],
    ]);
    for (const text of ["Human steering\nverbatim", "Human follow-up\nverbatim", "Human idle\nverbatim", "Human handled"]) expect(entries).toContainEqual(expect.objectContaining({ type: "custom", customType: "native-input-hook", data: { text, source: "interactive" } }));
    expect(asyncChild.inspect().initialResult).toEqual(initial);
    expect(supervisor.usage().turns).toBeGreaterThan(initial.usage.turns + syncChild.inspect().initialResult!.usage.turns);
    editorInputs.push("next gated turn");
    browser!.handleInput("p");
    await vi.waitFor(() => expect(existsSync(join(root, "entered-2"))).toBe(true));
    browser!.handleInput("c");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("cancellation settled"));
    editorInputs.push("exit while running");
    browser!.handleInput("p");
    await vi.waitFor(() => expect(existsSync(join(root, "entered-3"))).toBe(true));
    browser!.handleInput("\u001b");
    browser!.handleInput("\u001b");
    await interaction;
    expect(asyncChild.summary().state).toBe("running");
    await writeFile(join(root, "release-3"), "release");
    await vi.waitFor(() => expect(asyncChild.summary().state).toBe("idle"));
    expect(overlayHidden).toBe(false);
    expect(ui.getEditorText()).toBe(originalDraft);
    expect({ messages: parent.messages, model: parent.model, tools: parent.getActiveToolNames(), id: parent.sessionId }).toEqual(parentBefore);
    await parent.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    expect(spans.map((span) => span.name)).toContain("tooling.subagent.run");
    const exported = JSON.stringify(spans.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events })));
    for (const privateValue of [root, "Sync task\nexact original", "sync initial complete", "Explicit delegated instruction"]) expect(exported).not.toContain(JSON.stringify(privateValue).slice(1, -1));
  } finally {
    unsubscribeUpdates?.();
    browser?.close();
    await parent?.abort();
    await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    parent?.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("rejects obsolete selections and preserves native target trust, defaults and explicit selection safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "registered-native-selection-"));
  const agentDir = join(root, "agent");
  const target = join(root, "target");
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    await mkdir(agentDir);
    await mkdir(join(target, ".pi"), { recursive: true });
    const extension = join(agentDir, "provider.mjs");
    await writeFile(extension, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { writeFileSync } from 'node:fs';
export default function(pi) {
 const p = fauxProvider({provider:'selection-public',models:[{id:'faux-1'},{id:'selected'}]});
 let cwd;
 const recordRequest = () => { if(cwd === ${JSON.stringify(target)}) writeFileSync(${JSON.stringify(join(target, "model-turn"))},'started'); };
 pi.registerProvider({...p.provider,
   stream(...args) { recordRequest(); return p.provider.stream(...args); },
   streamSimple(...args) { recordRequest(); return p.provider.streamSimple(...args); }
 });
 pi.on('session_start',(_event,ctx)=> { cwd = ctx.cwd; });
 pi.on('input', event => {
   if(event.text.startsWith('launch:')) p.setResponses([
     fauxAssistantMessage(fauxToolCall('subagent',JSON.parse(event.text.slice(7))),{stopReason:'toolUse'}),
     fauxAssistantMessage('Parent settled')]);
   if(event.text === 'child task') p.setResponses([fauxAssistantMessage('native child answer')]);
 });
}`);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "selection-public", defaultModel: "faux-1", defaultTools: ["read"] }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "selection-public": { apiKey: "fixture-key" } } }));
    const targetExtension = join(target, ".pi", "target.mjs");
    await writeFile(targetExtension, `import { writeFileSync } from 'node:fs';
export default function(pi) { pi.on('session_start',()=> { writeFileSync(${JSON.stringify(join(target, "started"))},'started'); pi.registerTool({name:'target_tool',label:'Target',description:'Trusted startup tool',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'target'}],details:{}}}}); }); }`);
    await writeFile(join(target, ".pi", "settings.json"), JSON.stringify({ extensions: [targetExtension] }));
    await writeFile(join(target, "AGENTS.md"), "Native target AGENTS context remains active.");
    const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }), resourceLoaderReloadOptions: { resolveProjectTrust: async () => true }, resourceLoaderOptions: { extensionFactories: [initSubagent] } });
    parent = (await createAgentSessionFromServices({ services, tools: ["subagent"], sessionManager: SessionManager.create(root, join(root, "sessions")) })).session;
    await parent.bindExtensions({ mode: "print" });
    const supervisor = Control.getSubagentRunSupervisor(parent.sessionId)!;
    const launch = async (overrides: Record<string, unknown>) => {
      await rm(join(target, "started"), { force: true });
      await rm(join(target, "model-turn"), { force: true });
      await parent!.prompt(`launch:${JSON.stringify({ action: "run", name: "selection", task: "child task", cwd: target, ...overrides })}`);
      return parent!.messages.filter((m) => m.role === "toolResult").at(-1)!;
    };
    for (const action of ["run", "start", "list"]) {
      for (const obsolete of [{ agent: "scout" }, { agent_scope: "project" }, { agent: null }, { agent_scope: null }]) {
        const result = await launch({ action, ...obsolete });
        expect(result.isError, JSON.stringify(result)).toBe(true);
        expect(supervisor.children.size).toBe(0);
      }
    }
    // Parent is trusted, but an unknown different target must not execute project extensions.
    await launch({});
    let child = [...supervisor.children.values()].at(-1)!;
    expect(child.inspect().initialResult?.isError).toBe(false);
    expect(child.inspect().model).toBe("selection-public/faux-1");
    expect(child.inspect().activeTools).toEqual(["read"]);
    expect(child.inspect().callableTools).not.toContain("target_tool");
    expect(existsSync(join(target, "started"))).toBe(false);
    expect(existsSync(join(target, "model-turn"))).toBe(true);
    const store = new ProjectTrustStore(agentDir);
    store.set(target, true);
    const emptySelection = await launch({ tools: [], model: "selection-public/selected", system_prompt: "Explicit delegated instruction" });
    expect(emptySelection.details).toMatchObject({ isError: false, finalOutput: "native child answer", toolNames: [], model: "selection-public/selected" });
    expect(JSON.stringify(emptySelection.content)).toContain("native child answer");
    child = [...supervisor.children.values()].at(-1)!;
    expect(child.inspect().initialResult?.finalOutput).toBe("native child answer");
    expect(child.inspect().activeTools).toEqual([]);
    expect(child.inspect().callableTools).toEqual([]);
    expect(child.inspect().model).toBe("selection-public/selected");
    expect(child.inspect().systemPrompt).toContain("Native target AGENTS context remains active.");
    expect(child.inspect().systemPrompt).toContain("Explicit delegated instruction");
    expect(existsSync(join(target, "started"))).toBe(true);
    await launch({});
    child = [...supervisor.children.values()].at(-1)!;
    expect(child.inspect().activeTools).toEqual(["read", "target_tool"]);
    await launch({ tools: ["target_tool"] });
    child = [...supervisor.children.values()].at(-1)!;
    expect(child.inspect().activeTools).toEqual(["target_tool"]);
    expect(child.inspect().callableTools).toEqual(["target_tool"]);
    store.set(target, false);
    const deniedResult = await launch({ tools: ["target_tool"] });
    expect((deniedResult.details as { isError: boolean }).isError).toBe(true);
    const denied = [...supervisor.children.values()].at(-1)!;
    expect(denied.inspect().state).toBe("closed");
    store.set(target, true);
    for (const { overrides, startup } of [
      { overrides: { model: "missing/model" }, startup: false },
      { overrides: { tools: ["unavailable_tool"] }, startup: true },
      { overrides: { tools: ["r*"] }, startup: false },
    ]) {
      const result = await launch(overrides);
      expect((result.details as { isError: boolean }).isError, JSON.stringify(result)).toBe(true);
      expect(JSON.stringify(result.content)).toContain("unavailable");
      expect([...supervisor.children.values()].at(-1)!.inspect().state).toBe("closed");
      expect(existsSync(join(target, "started"))).toBe(startup);
      expect(existsSync(join(target, "model-turn"))).toBe(false);
    }
  } finally {
    await parent?.abort();
    await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    parent?.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
