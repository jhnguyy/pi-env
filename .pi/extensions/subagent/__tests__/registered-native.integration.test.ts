import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import initSubagent from "../index";
import { getSubagentRunSupervisor } from "../control";
import type { SubagentBrowser } from "../browser";

// Only terminal I/O and inference are scripted. Native parent tool calls launch native
// children; the registered slash command, input hooks, providers and files are real.
it("runs and resumes retained children through registered tools and direct browser input", async () => {
  const root = await mkdtemp(join(tmpdir(), "registered-native-"));
  const agentDir = join(root, "agent");
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  let browser: SubagentBrowser | undefined;
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
 pi.registerProvider(p.provider);
 pi.registerTool({name:'fixture_gate',label:'Gate',description:'Wait for a test-owned file or abort',parameters:{type:'object',properties:{},additionalProperties:false},async execute(_id,_params,signal) {
   const number = ++gates;
   writeFileSync(root+'/entered-'+number,'entered');
   while (!existsSync(root+'/release-'+number) && !signal?.aborted) await new Promise(resolve=>setTimeout(resolve,5));
   return {content:[{type:'text',text:'gate settled'}],details:{}};
 }});
 pi.on('input', event => {
   pi.appendEntry('native-input-hook',{text:event.text,source:event.source});
   if(event.text === 'root seed') p.setResponses([
     fauxAssistantMessage(fauxToolCall('subagent',{action:'run',name:'sync',task:'Sync task\\nexact original',tools:['read']}),{stopReason:'toolUse'}),
     fauxAssistantMessage(fauxToolCall('subagent',{action:'start',name:'async',task:'Async task\\nexact original',tools:['fixture_gate']}),{stopReason:'toolUse'}),
     fauxAssistantMessage('Parent ready')]);
   if(event.text === 'Sync task\\nexact original') p.setResponses([fauxAssistantMessage('sync initial complete')]);
   if(event.text === 'Async task\\nexact original') p.setResponses([fauxAssistantMessage(fauxToolCall('fixture_gate',{}),{stopReason:'toolUse'}),fauxAssistantMessage('async initial complete'),fauxAssistantMessage('follow-up complete'),fauxAssistantMessage('idle human complete')]);
   if(event.text === 'next gated turn') p.setResponses([fauxAssistantMessage(fauxToolCall('fixture_gate',{}),{stopReason:'toolUse'}),fauxAssistantMessage('cancelled turn settled')]);
 });
}`);
    await writeFile(join(root, "AGENTS.md"), "Native target context for browser inspection");
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "browser-child", defaultModel: "faux-1", defaultTools: ["read"] }));
    const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }), resourceLoaderReloadOptions: { resolveProjectTrust: async () => true }, resourceLoaderOptions: { extensionFactories: [initSubagent] } });
    parent = (await createAgentSessionFromServices({ services, tools: ["read", "subagent"], sessionManager: SessionManager.create(root, join(root, "sessions")) })).session;
    const draft = "Keep this parent draft";
    const hidden = vi.fn();
    const ui = {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setWidget: vi.fn(), notify: vi.fn(), getEditorText: () => draft, setEditorText: vi.fn(),
      editor: vi.fn<(...args: any[]) => Promise<string | undefined>>(),
      custom: (factory: any, options: any) => new Promise<void>((resolve) => {
        browser = factory({ terminal: { rows: 60 }, requestRender: vi.fn() }, ui.theme, {}, resolve);
        options.onHandle({ setHidden: hidden });
      }),
    };
    await parent.bindExtensions({ mode: "tui", uiContext: ui as any });
    await parent.prompt("root seed");
    expect(parent.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ text: "Parent ready" })]) }));
    await vi.waitFor(() => expect(existsSync(join(root, "entered-1"))).toBe(true));
    const supervisor = getSubagentRunSupervisor(parent.sessionId)!;
    expect(supervisor.children.size).toBe(2);
    const asyncChild = [...supervisor.children.values()].find((child) => child.summary().name === "async")!;
    const syncChild = [...supervisor.children.values()].find((child) => child.summary().name === "sync")!;
    expect(syncChild.inspect().initialResult?.finalOutput).toContain("sync initial complete");
    const parentBefore = { messages: structuredClone(parent.messages), model: parent.model, tools: parent.getActiveToolNames(), id: parent.sessionId };
    const interaction = parent.prompt("/subagents");
    await vi.waitFor(() => expect(browser).toBeDefined());
    expect(browser!.render(160).join("\n")).toContain("2 retained sessions");
    browser!.handleInput("\u001b[B");
    browser!.handleInput("\r");
    browser!.handleInput("\t");
    expect(browser!.render(160).join("\n")).toContain("Native target context for browser inspection");
    ui.editor.mockResolvedValueOnce("Human steering\nverbatim");
    browser!.handleInput("s");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("queued"));
    ui.editor.mockResolvedValueOnce("Human follow-up\nverbatim");
    browser!.handleInput("f");
    await vi.waitFor(() => expect(asyncChild.inspect().inputs).toHaveLength(3));
    await writeFile(join(root, "release-1"), "release");
    await vi.waitFor(() => expect(asyncChild.inspect().initialResult).toBeDefined());
    const initial = asyncChild.inspect().initialResult!;
    expect(initial.isError).toBe(false);
    await vi.waitFor(() => expect(asyncChild.summary().state).toBe("idle"));
    ui.editor.mockResolvedValueOnce("Human idle\nverbatim");
    browser!.handleInput("p");
    const file = asyncChild.summary().sessionFile!;
    await vi.waitFor(async () => expect(await readFile(file, "utf8")).toContain("idle human complete"));
    await vi.waitFor(() => expect(asyncChild.summary().state).toBe("idle"));
    const entries = SessionManager.open(file).getEntries();
    const provenance = entries.filter((entry) => entry.type === "custom" && entry.customType === "subagent-input").map((entry: any) => entry.data);
    expect(provenance.map((input) => [input.source, input.mode, input.text])).toEqual([
      ["coordinator", "prompt", "Async task\nexact original"],
      ["human", "steer", "Human steering\nverbatim"],
      ["human", "followUp", "Human follow-up\nverbatim"],
      ["human", "prompt", "Human idle\nverbatim"],
    ]);
    expect(entries).toContainEqual(expect.objectContaining({ type: "custom", customType: "native-input-hook", data: { text: "Human idle\nverbatim", source: "interactive" } }));
    expect(asyncChild.inspect().initialResult).toEqual(initial);
    expect(supervisor.usage().turns).toBeGreaterThan(initial.usage.turns + syncChild.inspect().initialResult!.usage.turns);
    ui.editor.mockResolvedValueOnce("next gated turn");
    browser!.handleInput("p");
    await vi.waitFor(() => expect(existsSync(join(root, "entered-2"))).toBe(true));
    browser!.handleInput("c");
    await vi.waitFor(() => expect(browser!.render(160).join("\n")).toContain("cancellation settled"));
    browser!.handleInput("\u001b");
    browser!.handleInput("\u001b");
    await interaction;
    expect(hidden.mock.calls).toEqual([[true], [false], [true], [false], [true], [false], [true], [false]]);
    expect(ui.setEditorText).not.toHaveBeenCalled();
    expect(ui.getEditorText()).toBe(draft);
    expect({ messages: parent.messages, model: parent.model, tools: parent.getActiveToolNames(), id: parent.sessionId }).toEqual(parentBefore);
  } finally {
    browser?.close();
    await parent?.abort();
    await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    parent?.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
