import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import initSubagent from "../index";
import type * as Browser from "../browser";
import type { SubagentDetails, SubagentJobRenderDetails } from "../types";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import * as Tooling from "../../../../src/telemetry/tooling";
import { RegisteredServiceFixture } from "./registered-service.fixture";

type Parent = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
async function tool(parent: Parent, params: Record<string, unknown>) {
  const registered = parent.agent.state.tools.find((entry) => entry.name === "subagent");
  if (!registered) throw new Error("Missing registered subagent tool");
  return await registered.execute(randomUUID(), params) as AgentToolResult<SubagentDetails & SubagentJobRenderDetails>;
}
function text(result: { content: unknown }): string {
  return (result.content as { type: string; text?: string }[]).flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n");
}
async function roster(parent: Parent) {
  const result = await tool(parent, { action: "list" });
  return text(result).split("\n").flatMap((line) => {
    const match = /^\[([^\]]+)\] (\S+) (.*?) child:(\S+)/.exec(line);
    return match ? [{ status: match[1], jobId: match[2], name: match[3], childId: match[4] }] : [];
  });
}
async function inspect(parent: Parent, childId: string, view = "conversation") {
  return tool(parent, { action: "inspect", child_id: childId, view, limit: 16384 });
}

// Only terminal I/O, inference and the telemetry collector are substituted.
// Registered tools, lazy browser inspection, the detached service and native files are real.
it("continues durable children through registered tools and browser input across parent shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "registered-native-"));
  const agentDir = join(root, "agent");
  const service = new RegisteredServiceFixture(agentDir);
  let parent: Parent | undefined;
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
   if(signal?.aborted) writeFileSync(root+'/aborted-'+number,'aborted');
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
    new ProjectTrustStore(agentDir).set(root, true);
    await service.start();
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
    // Native focus/draft restoration is covered by the CLI smoke; this substitutes terminal transport only.
    const ui = {
      theme: { fg: (_color: string, value: string) => value, bold: (value: string) => value },
      setWidget: vi.fn(), notify: vi.fn(), getEditorText: () => draft, setEditorText: (value: string) => { draft = value; },
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
    const children = await roster(parent);
    expect(children).toHaveLength(2);
    const asyncChild = children.find((child) => child.name === "async")!;
    const syncChild = children.find((child) => child.name === "sync")!;
    expect(text(await tool(parent, { action: "result", job_id: syncChild.jobId }))).toContain("sync initial complete");
    expect(text(await inspect(parent, syncChild.childId))).toContain("target identity");
    const syncResult = parent.messages.filter((message) => message.role === "toolResult").find((message) => message.toolName === "subagent");
    if (!syncResult) throw new Error("Missing synchronous subagent tool result");
    expect(syncResult.details).toMatchObject({ finalOutput: "sync initial complete", isError: false });
    expect(parent.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName)).toEqual(["subagent", "subagent"]);
    expect(updates.flatMap((update) => update.toolCallId === syncResult.toolCallId ? [update.content] : []).join("\n")).toContain("sync initial complete");
    const parentBefore = { messages: structuredClone(parent.messages), model: parent.model, tools: parent.getActiveToolNames(), id: parent.sessionId };
    const interaction = parent.prompt("/subagents");
    await vi.waitFor(() => expect(browser).toBeDefined());
    expect(browser!.render(160).join("\n")).toContain("2 retained sessions");
    browser!.handleInput("\u001b[B");
    browser!.handleInput("\r");
    browser!.handleInput("\t");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("Native target context for browser inspection"));
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("async [running]"));
    editorInputs.push("Human steering\nverbatim");
    browser!.handleInput("s");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("Steering queued for native processing."));
    editorInputs.push("Human follow-up\nverbatim");
    browser!.handleInput("f");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("Follow-up queued for native processing."));
    expect(text(await inspect(parent, asyncChild.childId, "provenance"))).toContain("Human follow-up");
    await writeFile(join(root, "release-1"), "release");
    await vi.waitFor(async () => expect((await tool(parent!, { action: "status", job_id: asyncChild.jobId })).details.status).toBe("completed"));
    const initial = await tool(parent, { action: "result", job_id: asyncChild.jobId });
    expect(text(initial)).toContain("follow-up complete");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("idle"));
    editorInputs.push("Human idle\nverbatim");
    browser!.handleInput("p");
    const file = (await inspect(parent, asyncChild.childId)).details.sessionFile!;
    await vi.waitFor(async () => expect(await readFile(file, "utf8")).toContain("idle human complete"));
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("Native prompt settled."));
    const beforeHandled = SessionManager.open(file).buildSessionContext().messages.filter((message) => message.role === "assistant");
    const countRequests = () => SessionManager.open(file).getEntries().filter((entry) => entry.type === "custom" && entry.customType === "fixture-provider-request").length;
    const requestsBeforeHandled = countRequests();
    expect(requestsBeforeHandled).toBeGreaterThan(0);
    editorInputs.push("Human handled");
    browser!.handleInput("p");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("Handled by a child input hook; no model turn started."));
    expect(SessionManager.open(file).buildSessionContext().messages.filter((message) => message.role === "assistant")).toEqual(beforeHandled);
    expect(countRequests()).toBe(requestsBeforeHandled);
    expect(text(await inspect(parent, asyncChild.childId))).toContain("idle human complete");
    const entries = SessionManager.open(file).getEntries();
    const provenance = entries.filter((entry) => entry.type === "custom" && entry.customType === "subagent-input").map((entry: any) => entry.data);
    expect(provenance.map((input) => [input.source, input.mode, input.text])).toEqual([
      ["coordinator", "prompt", "Async task\nexact original"],
      ["human", "steer", "Human steering\nverbatim"],
      ["human", "followUp", "Human follow-up\nverbatim"],
      ["human", "prompt", "Human idle\nverbatim"],
      ["human", "prompt", "Human handled"],
    ]);
    for (const value of ["Human steering\nverbatim", "Human follow-up\nverbatim", "Human idle\nverbatim", "Human handled"]) expect(entries).toContainEqual(expect.objectContaining({ type: "custom", customType: "native-input-hook", data: { text: value, source: "interactive" } }));
    expect(text(await tool(parent, { action: "result", job_id: asyncChild.jobId }))).toBe(text(initial));
    editorInputs.push("next gated turn");
    browser!.handleInput("p");
    await vi.waitFor(() => expect(existsSync(join(root, "entered-2"))).toBe(true));
    browser!.handleInput("c");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("cancellation settled"));
    expect(existsSync(join(root, "aborted-2"))).toBe(true);
    editorInputs.push("exit while running");
    browser!.handleInput("p");
    await vi.waitFor(() => expect(existsSync(join(root, "entered-3"))).toBe(true));
    browser!.handleInput("\u001b");
    browser!.handleInput("\u001b");
    await interaction;
    expect(overlayHidden).toBe(false);
    expect(ui.getEditorText()).toBe(originalDraft);
    expect({ messages: parent.messages, model: parent.model, tools: parent.getActiveToolNames(), id: parent.sessionId }).toEqual(parentBefore);
    // Closing a parent disconnects its client, not the service-owned native prompt.
    await parent.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    const parentFile = parent.sessionManager.getSessionFile()!;
    parent.dispose();
    const resumedServices = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }), resourceLoaderReloadOptions: { resolveProjectTrust: async () => true }, resourceLoaderOptions: { extensionFactories: [initSubagent] } });
    parent = (await createAgentSessionFromServices({ services: resumedServices, tools: ["read", "subagent"], sessionManager: SessionManager.open(parentFile) })).session;
    await parent.bindExtensions({ mode: "tui", uiContext: ui as any });
    expect(parent.sessionId).toBe(parentBefore.id);
    expect(await roster(parent)).toEqual(children.map((child) => child.name === "async" ? { ...child, status: "completed" } : child));
    expect(existsSync(join(root, "aborted-3"))).toBe(false);
    await writeFile(join(root, "release-3"), "release");
    await vi.waitFor(async () => expect(text(await inspect(parent!, asyncChild.childId))).toContain("gated turn settled"));
    expect(text(await tool(parent, { action: "result", job_id: asyncChild.jobId }))).toBe(text(initial));
    const requestsBeforeReopen = countRequests();
    await tool(parent, { action: "reopen", child_id: asyncChild.childId });
    expect(countRequests()).toBe(requestsBeforeReopen);
    expect(text(await tool(parent, { action: "result", job_id: asyncChild.jobId }))).toBe(text(initial));
    expect(text(await tool(parent, { action: "input", child_id: syncChild.childId, text: "Human handled", mode: "prompt" }))).toContain("Handled by a child input hook");
    expect(text(await inspect(parent, syncChild.childId, "provenance"))).toContain("coordinator · prompt");
    expect(spans.map((span) => span.name)).toContain("tooling.subagent.run");
    const exported = JSON.stringify(spans.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events })));
    for (const privateValue of [root, "Sync task\nexact original", "sync initial complete", "Explicit delegated instruction"]) expect(exported).not.toContain(JSON.stringify(privateValue).slice(1, -1));
  } finally {
    unsubscribeUpdates?.();
    browser?.close();
    try {
      await parent?.abort();
      await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      parent?.dispose();
    } finally {
      vi.unstubAllEnvs();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 60000);

it("rejects obsolete selections and preserves native target trust, defaults and explicit selection safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "registered-native-selection-"));
  const agentDir = join(root, "agent");
  const target = join(root, "target");
  const service = new RegisteredServiceFixture(agentDir);
  let parent: Parent | undefined;
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
    await service.start();
    const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }), resourceLoaderReloadOptions: { resolveProjectTrust: async () => true }, resourceLoaderOptions: { extensionFactories: [initSubagent] } });
    parent = (await createAgentSessionFromServices({ services, tools: ["subagent"], sessionManager: SessionManager.create(root, join(root, "sessions")) })).session;
    await parent.bindExtensions({ mode: "print" });
    const latest = async () => (await roster(parent!)).at(-1)!;
    const launch = async (overrides: Record<string, unknown>) => {
      await rm(join(target, "started"), { force: true });
      await rm(join(target, "model-turn"), { force: true });
      await parent!.prompt(`launch:${JSON.stringify({ action: "run", name: "selection", task: "child task", cwd: target, ...overrides })}`);
      return parent!.messages.filter((message) => message.role === "toolResult").at(-1)!;
    };
    for (const action of ["run", "start", "list"]) {
      for (const obsolete of [{ agent: "scout" }, { agent_scope: "project" }, { agent: null }, { agent_scope: null }]) {
        const result = await launch({ action, ...obsolete });
        expect(result.isError, JSON.stringify(result)).toBe(true);
        expect(await roster(parent)).toHaveLength(0);
      }
    }
    // Trusting the parent must not authorize a different target's project extensions.
    await launch({});
    let child = await latest();
    expect(child.status).toBe("completed");
    let configuration = text(await inspect(parent, child.childId, "configuration"));
    expect(configuration).toContain("Model: selection-public/faux-1");
    expect(configuration).toContain("Active tools\nread\n\nCallable tools\nread");
    expect(configuration).not.toContain("target_tool");
    expect(existsSync(join(target, "started"))).toBe(false);
    expect(existsSync(join(target, "model-turn"))).toBe(true);
    const store = new ProjectTrustStore(agentDir);
    store.set(target, true);
    const emptySelection = await launch({ tools: [], model: "selection-public/selected", system_prompt: "Explicit delegated instruction" });
    expect(emptySelection.details).toMatchObject({ isError: false, finalOutput: "native child answer", toolNames: [], model: "selection-public/selected" });
    expect(JSON.stringify(emptySelection.content)).toContain("native child answer");
    child = await latest();
    expect(text(await tool(parent, { action: "result", job_id: child.jobId }))).toContain("native child answer");
    configuration = text(await inspect(parent, child.childId, "configuration"));
    expect(configuration).toContain("Active tools\n(none)\n\nCallable tools\n(none)");
    expect(configuration).toContain("Model: selection-public/selected");
    const instructions = text(await inspect(parent, child.childId, "instructions"));
    expect(instructions).toContain("Native target AGENTS context remains active.");
    expect(instructions).toContain("Explicit delegated instruction");
    expect(existsSync(join(target, "started"))).toBe(true);
    await launch({});
    child = await latest();
    expect(text(await inspect(parent, child.childId, "configuration"))).toContain("Active tools\nread\ntarget_tool");
    await launch({ tools: ["target_tool"] });
    child = await latest();
    expect(text(await inspect(parent, child.childId, "configuration"))).toContain("Active tools\ntarget_tool\n\nCallable tools\ntarget_tool");
    store.set(target, false);
    const deniedResult = await launch({ tools: ["target_tool"] });
    expect((deniedResult.details as { isError: boolean }).isError).toBe(true);
    expect((await latest()).status).toBe("failed");
    store.set(target, true);
    for (const { overrides, startup } of [
      { overrides: { model: "missing/model" }, startup: false },
      { overrides: { tools: ["unavailable_tool"] }, startup: true },
      { overrides: { tools: ["r*"] }, startup: false },
    ]) {
      const result = await launch(overrides);
      expect((result.details as { isError: boolean }).isError, JSON.stringify(result)).toBe(true);
      expect(JSON.stringify(result.content)).toContain("unavailable");
      if ("model" in overrides) expect(JSON.stringify(result.content)).toMatch(/Available: \S+\/\S+/);
      expect(existsSync(join(target, "started"))).toBe(startup);
      expect(existsSync(join(target, "model-turn"))).toBe(false);
    }
  } finally {
    try {
      await parent?.abort();
      await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      parent?.dispose();
    } finally {
      vi.unstubAllEnvs();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 60000);

it("preserves accepted work across disconnect and explicitly reopens interrupted history without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "registered-native-disconnect-"));
  const agentDir = join(root, "agent");
  const service = new RegisteredServiceFixture(agentDir);
  let parent: Parent | undefined;
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    await mkdir(agentDir);
    const extension = join(agentDir, "provider.mjs");
    await writeFile(extension, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
export default function(pi) {
 const p = fauxProvider({provider:'disconnect-child'});
 pi.registerProvider(p.provider);
 pi.registerTool({name:'fixture_gate',label:'Gate',description:'Controlled external effect',parameters:{type:'object',properties:{marker:{type:'string'}},required:['marker']},async execute(_id,{marker},signal) {
   appendFileSync(root+'/entered-'+marker,'entered\\n');
   while (!existsSync(root+'/release-'+marker) && !signal?.aborted) await new Promise(resolve=>setTimeout(resolve,5));
   writeFileSync(root+'/'+(signal?.aborted?'aborted-':'settled-')+marker,'settled');
   return {content:[{type:'text',text:'gate settled'}],details:{}};
 }});
 pi.on('input', event => {
   if(event.text === 'parent ready') p.setResponses([fauxAssistantMessage('ready')]);
   if(event.text === 'resume after crash') p.setResponses([fauxAssistantMessage('explicit resumed answer')]);
   if(event.text === 'survive' || event.text === 'cancel' || event.text === 'crash') p.setResponses([
     fauxAssistantMessage(fauxToolCall('fixture_gate',{marker:event.text}),{stopReason:'toolUse'}),
     fauxAssistantMessage('accepted answer '+event.text)]);
 });
}`);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "disconnect-child", defaultModel: "faux-1", defaultTools: ["fixture_gate"] }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "disconnect-child": { apiKey: "fixture-key" } } }));
    await service.start();
    const open = async (manager: SessionManager) => {
      const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }), resourceLoaderReloadOptions: { resolveProjectTrust: async () => true }, resourceLoaderOptions: { extensionFactories: [initSubagent] } });
      const session = (await createAgentSessionFromServices({ services, tools: ["subagent"], sessionManager: manager })).session;
      await session.bindExtensions({ mode: "print" });
      return session;
    };
    parent = await open(SessionManager.create(root, join(root, "sessions")));
    await parent.prompt("parent ready");
    const started = await tool(parent, { action: "start", name: "survivor", task: "survive" });
    const jobId = started.details.jobId!;
    await vi.waitFor(() => expect(existsSync(join(root, "entered-survive"))).toBe(true));
    const before = (await roster(parent)).find((entry) => entry.jobId === jobId)!;
    const parentId = parent.sessionId;
    const parentFile = parent.sessionManager.getSessionFile()!;
    await parent.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    parent.dispose();
    parent = await open(SessionManager.open(parentFile));
    expect(parent.sessionId).toBe(parentId);
    expect(await roster(parent)).toContainEqual(before);
    expect((await tool(parent, { action: "status", job_id: jobId })).details.status).toBe("running");
    expect(existsSync(join(root, "aborted-survive"))).toBe(false);
    await writeFile(join(root, "release-survive"), "release");
    await vi.waitFor(async () => expect((await tool(parent!, { action: "status", job_id: jobId })).details.status).toBe("completed"));
    expect(existsSync(join(root, "settled-survive"))).toBe(true);
    expect(text(await tool(parent, { action: "result", job_id: jobId }))).toContain("accepted answer survive");
    const cancelled = await tool(parent, { action: "start", name: "cancelled", task: "cancel" });
    await vi.waitFor(() => expect(existsSync(join(root, "entered-cancel"))).toBe(true));
    await tool(parent, { action: "cancel", job_id: cancelled.details.jobId });
    await vi.waitFor(async () => expect((await tool(parent!, { action: "status", job_id: cancelled.details.jobId })).details.status).toBe("cancelled"));
    expect(existsSync(join(root, "aborted-cancel"))).toBe(true);
    expect(existsSync(join(root, "settled-cancel"))).toBe(false);
    expect(text(await tool(parent, { action: "result", job_id: jobId }))).toContain("accepted answer survive");
    const interrupted = await tool(parent, { action: "start", name: "interrupted", task: "crash" });
    await vi.waitFor(() => expect(existsSync(join(root, "entered-crash"))).toBe(true));
    const interruptedChild = (await roster(parent)).find((entry) => entry.jobId === interrupted.details.jobId)!;
    await service.crash();
    await parent.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    parent.dispose();
    await service.start();
    parent = await open(SessionManager.open(parentFile));
    expect((await tool(parent, { action: "status", job_id: interrupted.details.jobId })).details.status).toBe("interrupted");
    await expect(tool(parent, { action: "input", child_id: interruptedChild.childId, text: "resume after crash", mode: "prompt" })).rejects.toThrow(/reopen/);
    await tool(parent, { action: "reopen", child_id: interruptedChild.childId });
    expect(await readFile(join(root, "entered-crash"), "utf8")).toBe("entered\n");
    const resumed = await tool(parent, { action: "input", child_id: interruptedChild.childId, text: "resume after crash", mode: "prompt" });
    expect(text(resumed)).toContain("explicit resumed answer");
    expect(text(await tool(parent, { action: "result", job_id: resumed.details.jobId }))).toContain("explicit resumed answer");
    expect(text(await inspect(parent, interruptedChild.childId))).toContain("explicit resumed answer");
    expect(await readFile(join(root, "entered-crash"), "utf8")).toBe("entered\n");
    expect((await tool(parent, { action: "status", job_id: interrupted.details.jobId })).details.status).toBe("interrupted");
    expect(text(await tool(parent, { action: "result", job_id: jobId }))).toContain("accepted answer survive");
  } finally {
    try {
      await parent?.abort();
      await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      parent?.dispose();
    } finally {
      vi.unstubAllEnvs();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 60000);
