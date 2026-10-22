import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bundle = join(repo, ".pi/extensions/subagent/dist/index.js");

// Only inference is scripted. Both sessions load native resources and execute real tools.
it.each(["on", "only"] as const)("delegates through native codemode (%s) without recursive delegation", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-delegation-"));
  const agentDir = join(root, "agent");
  const target = join(root, "target");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const evidenceDir = process.env.PI_ENV_NATIVE_TOOL_ARTIFACT_DIR ?? tmpdir();
  mkdirSync(evidenceDir, { recursive: true });
  const artifact = join(mkdtempSync(join(evidenceDir, "pi-native-delegation-")), "result.json");
  const evidence: Record<string, unknown> = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim().length > 0,
    repeat: "nub run build && nub run test:e2e:native-tools",
    input: { mode, actions: ["run", "start", "wait", "result"], childTools: "target-native defaults", cancellation: "parent abort during a nested child tool" },
    expected: "Children use their own codemode without recursive delegation. Nested usage is reported once. Parent abort reaches the child tool, which settles cooperatively.",
    verdict: "failed",
  };
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  try {
    mkdirSync(agentDir);
    mkdirSync(target);
    writeFileSync(join(root, "identity.txt"), "parent identity must not leak");
    writeFileSync(join(target, "identity.txt"), "child-native identity");
    const childCode = `text(await tools.read({path: "identity.txt"})); text({parentTool: ALL_TOOLS.some(t => t.name === "parent_only"), delegation: ALL_TOOLS.some(t => t.name === "subagent"), codemode: ALL_TOOLS.some(t => t.name === "codemode")}); let blocked = false; try { await tools.subagent({action:"run",name:"recursive",task:"must not run"}); } catch (error) { blocked = true; text("recursive call blocked: " + error.message); } if (!blocked) throw Error("recursive delegation was allowed");`;
    const parentCode = `text(await tools.subagent({action:"run",name:"blocking",task:"child task",cwd:${JSON.stringify(target)}})); const started = await tools.subagent({action:"start",name:"background",task:"child task",cwd:${JSON.stringify(target)}}); const id = started.match(/Started subagent job ([\\w-]+)/)?.[1]; if (!id) throw Error(started); text(await tools.subagent({action:"wait",job_id:id})); text(await tools.subagent({action:"result",job_id:id}));`;
    const cancelCode = `text(await tools.subagent({action:"run",name:"cancelled",task:"blocked task",cwd:${JSON.stringify(target)}}));`;
    const provider = join(agentDir, "provider.mjs");
    writeFileSync(provider, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { writeFileSync } from 'node:fs';
export default function(pi) {
 const p = fauxProvider({provider:'native-delegation'});
 pi.registerProvider(p.provider);
 pi.registerTool({name:'fixture_gate',label:'Gate',description:'Cooperative cancellation fixture',parameters:{type:'object',properties:{}},async execute(_id,_params,signal) {
   writeFileSync(${JSON.stringify(join(target, "entered"))},'entered');
   await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort',resolve,{once:true}); });
   await new Promise(resolve => setTimeout(resolve,25));
   writeFileSync(${JSON.stringify(join(target, "settled"))},'settled');
   return {content:[{type:'text',text:'gate settled'}],details:undefined};
 }});
 pi.on('input', event => {
   pi.appendEntry('delegation-loadout',{active:pi.getActiveTools(),registered:pi.getAllTools().map(t=>t.name)});
   if (event.text === 'launch') p.setResponses([
     fauxAssistantMessage(fauxToolCall('codemode',{code:${JSON.stringify(parentCode)}}),{stopReason:'toolUse'}),
     fauxAssistantMessage('parent complete')]);
   if (event.text === 'cancel') p.setResponses([
     fauxAssistantMessage(fauxToolCall('codemode',{code:${JSON.stringify(cancelCode)}}),{stopReason:'toolUse'}),
     fauxAssistantMessage('parent cancelled')]);
   if (event.text === 'blocked task') p.setResponses([
     fauxAssistantMessage(fauxToolCall('fixture_gate',{}),{stopReason:'toolUse'}),
     fauxAssistantMessage('gate complete')]);
   if (event.text === 'child task') {
     const done = fauxAssistantMessage('child complete');
     p.setResponses([
       fauxAssistantMessage(fauxToolCall('codemode',{code:${JSON.stringify(childCode)}}),{stopReason:'toolUse'}),
       fauxAssistantMessage(fauxToolCall('subagent',{action:'run',name:'recursive',task:'must not run'}),{stopReason:'toolUse'}),
       done]);
   }
 });
}`);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      extensions: [provider, bundle], defaultProvider: "native-delegation", defaultModel: "faux-1",
      defaultTools: ["+codemode"], codemode: { mode },
    }));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "native-delegation": { apiKey: "fixture-key" } } }));
    const services = await createAgentSessionServices({
      cwd: root, agentDir,
      settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }),
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
      resourceLoaderOptions: { extensionFactories: [createCodemodeExtension(), (pi) => {
        pi.registerTool({ name: "parent_only", label: "Parent only", description: "Parent-private fixture", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "parent only" }], details: undefined }) });
      }] },
    });
    parent = (await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(root, join(root, "sessions")) })).session;
    await parent.bindExtensions({ mode: "print" });
    await parent.prompt("launch");
    const parentCodeResults = parent.messages.filter(
      (message) => message.role === "toolResult" && message.toolName === "codemode",
    );
    evidence.parentCodeResults = parentCodeResults;
    expect(parentCodeResults).toHaveLength(1);
    expect(parentCodeResults.every((message) => message.role === "toolResult" && !message.isError)).toBe(true);
    const result = parentCodeResults.find((message) => message.role === "toolResult" && !message.isError);
    expect(result?.role).toBe("toolResult");
    if (result?.role !== "toolResult") throw new Error("Missing parent codemode result");
    evidence.parentResult = result;
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("child complete");
    expect(result.nestedCalls?.calls.map((call) => call.name)).toEqual(["subagent", "subagent", "subagent", "subagent"]);
    const childDirectory = join(parent.sessionManager.getSessionDir(), "_children", parent.sessionId);
    const files = readdirSync(childDirectory).filter((file) => file.endsWith(".jsonl"));
    expect(files).toHaveLength(2);
    const children = files.map((file) => SessionManager.open(join(childDirectory, file)));
    evidence.children = children.map((child) => child.buildSessionContext().messages);
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const child of children) {
      const messages = child.buildSessionContext().messages;
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite;
      }
      const codeResults = messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "codemode",
      );
      expect(codeResults).toHaveLength(1);
      expect(codeResults.every((message) => message.role === "toolResult" && !message.isError)).toBe(true);
      const codeResult = codeResults.find((message) => message.role === "toolResult" && !message.isError);
      expect(codeResult?.role === "toolResult" && codeResult.isError).toBe(false);
      expect(JSON.stringify(codeResult)).toContain("child-native identity");
      expect(JSON.stringify(codeResult)).not.toContain("parent identity must not leak");
      expect(JSON.stringify(codeResult)).toContain('\\"parentTool\\":false');
      expect(JSON.stringify(codeResult)).toContain('\\"delegation\\":false');
      expect(JSON.stringify(codeResult)).toContain('\\"codemode\\":false');
      expect(JSON.stringify(codeResult)).toContain("recursive call blocked:");
      const rejected = messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
      expect(rejected?.role === "toolResult" && rejected.isError).toBe(true);
      expect(child.getEntries()).toContainEqual(expect.objectContaining({ type: "custom", customType: "delegation-loadout", data: { active: expect.arrayContaining(["codemode"]), registered: expect.not.arrayContaining(["subagent", "parent_only"]) } }));
    }
    expect(usage.input).toBeGreaterThan(0);
    expect(result.usage).toEqual(expect.objectContaining(usage));
    const cancellationStarted = performance.now();
    const cancellationMessageStart = parent.messages.length;
    let cancellationFinished = false;
    const cancelled = parent.prompt("cancel").then(() => {
      cancellationFinished = true;
      evidence.cancellationFinishedAfterMs = performance.now() - cancellationStarted;
      evidence.cancellationOutput = parent?.messages.slice(cancellationMessageStart);
    });
    await vi.waitUntil(
      () => {
        if (existsSync(join(target, "entered"))) return true;
        if (cancellationFinished) {
          throw new Error(
            `Cancellation prompt ended before fixture_gate: ${JSON.stringify(evidence.cancellationOutput).slice(0, 4000)}`,
          );
        }
        return false;
      },
      { timeout: 1000 },
    );
    evidence.cancellationReadyAfterMs = performance.now() - cancellationStarted;
    await parent.abort();
    await cancelled;
    await vi.waitFor(() => expect(existsSync(join(target, "settled"))).toBe(true));
    const cancellationSettled = existsSync(join(target, "settled"));
    evidence.cancellationSettled = cancellationSettled;
    expect(cancellationSettled).toBe(true);
    evidence.verdict = "passed";
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      await parent?.abort();
      await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      parent?.dispose();
      vi.unstubAllEnvs();
      writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n");
      console.info(`Native delegation evidence: ${artifact}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30000);
