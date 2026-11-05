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
  ProjectTrustStore,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";

import { settleOperations, testCleanup } from "./cleanup";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bundle = join(repo, ".pi/extensions/subagent/dist/index.js");

it("composes built notes and general extensions in a native child with target-local settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-compat-"));
  const cleanup = testCleanup();
  cleanup(() => rmSync(root, { recursive: true, force: true }));
  cleanup(() => vi.unstubAllEnvs());
  const agentDir = join(root, "agent");
  const target = join(root, "target");
  const rootVault = join(root, "root-vault");
  const targetVault = join(root, "target-vault");
  for (const directory of [agentDir, target, rootVault, targetVault, join(target, ".pi")]) {
    mkdirSync(directory, { recursive: true });
  }
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const writes = vi.spyOn(process.stdout, "write");
  const runtimeErrors = vi.spyOn(ExtensionRunner.prototype, "emitError");
  cleanup(() => vi.restoreAllMocks());
  const settledDispatches: { runner: ExtensionRunner; cwd: string; paths: string[] }[] = [];
  const originalEmit = ExtensionRunner.prototype.emit;
  vi.spyOn(ExtensionRunner.prototype, "emit").mockImplementation(async function (
    this: ExtensionRunner,
    ...args
  ) {
    const snapshot =
      args[0].type === "agent_settled"
        ? { runner: this, cwd: this.createContext().cwd, paths: this.getExtensionPaths() }
        : undefined;
    const result = await originalEmit.apply(this, args);
    if (snapshot) settledDispatches.push(snapshot);
    return result;
  });
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  const operations: Promise<unknown>[] = [];
  cleanup(
    () => parent?.abort(),
    () => parent?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    () => settleOperations(operations),
    () => parent?.dispose(),
    () => expect(runtimeErrors.mock.calls).toEqual([]),
  );
  writeFileSync(join(rootVault, "identity.md"), "ROOT_VAULT_ONLY");
  writeFileSync(join(targetVault, "identity.md"), "TARGET_VAULT_ONLY");
  const provider = join(agentDir, "compat-provider.mjs");
  writeFileSync(
    provider,
    `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
 const p = fauxProvider({provider:'native-compat'});
 pi.registerProvider(p.provider);
 const observe = (phase, ctx) => pi.appendEntry('native-compat', {
   phase, mode:ctx.mode, hasUI:ctx.hasUI, trusted:ctx.isProjectTrusted(), cwd:ctx.cwd,
   active:pi.getActiveTools(), registered:pi.getAllTools().map(t=>t.name)
 });
 pi.on('agent_settled', (_event, ctx) => observe('settled', ctx));
 pi.on('input', (event, ctx) => {
   observe('input', ctx);
   const read = fauxAssistantMessage(fauxToolCall('notes',{action:'read',path:'identity.md'}),{stopReason:'toolUse'});
   if (event.text === 'root read') p.setResponses([read, fauxAssistantMessage('root read complete')]);
   if (event.text === 'delegate') p.setResponses([
     fauxAssistantMessage(fauxToolCall('subagent',{action:'run',name:'compat',task:'child read',cwd:${JSON.stringify(target)}}),{stopReason:'toolUse'}),
     fauxAssistantMessage('root delegation complete')]);
   if (event.text === 'child read') p.setResponses([read, fauxAssistantMessage('child read complete')]);
 });
}`,
  );
  const composition = [
    provider,
    bundle,
    join(repo, ".pi/extensions/notes/dist/index.js"),
    join(repo, ".pi/extensions/general/dist/index.js"),
  ];
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: composition,
      defaultProvider: "native-compat",
      defaultModel: "faux-1",
      notes: { provider: "obsidian", vaultPath: rootVault },
    }),
  );
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: { "native-compat": { apiKey: "harmless-fake-key" } },
    }),
  );
  writeFileSync(
    join(target, ".pi/settings.json"),
    JSON.stringify({
      notes: { provider: "obsidian", vaultPath: targetVault },
    }),
  );
  new ProjectTrustStore(agentDir).set(target, true);
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }),
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
  });
  expect(services.diagnostics.filter((d) => d.type === "error")).toEqual([]);
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  expect(
    services.resourceLoader.getExtensions().extensions.map((extension) => extension.path),
  ).toEqual(expect.arrayContaining(composition));
  parent = (
    await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(root, join(root, "sessions")),
    })
  ).session;
  await parent.bindExtensions({ mode: "print" });
  const prompt = async (text: string) => {
    const operation = parent.prompt(text);
    operations.push(operation);
    await operation;
  };
  await prompt("root read");
  const rootRead = parent.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "notes",
  );
  expect(rootRead).toMatchObject({ isError: false });
  expect(JSON.stringify(rootRead)).toContain("ROOT_VAULT_ONLY");
  expect(JSON.stringify(rootRead)).not.toContain("TARGET_VAULT_ONLY");
  await prompt("delegate");
  const delegated = parent.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "subagent",
  );
  expect(delegated).toMatchObject({ isError: false });
  expect(JSON.stringify(delegated)).toContain("child read complete");
  const childDirectory = join(parent.sessionManager.getSessionDir(), "_children", parent.sessionId);
  const children = readdirSync(childDirectory).filter((file) => file.endsWith(".jsonl"));
  expect(children).toHaveLength(1);
  const child = SessionManager.open(join(childDirectory, children[0]));
  const childRead = child
    .buildSessionContext()
    .messages.find((message) => message.role === "toolResult" && message.toolName === "notes");
  expect(childRead).toMatchObject({ isError: false });
  expect(JSON.stringify(childRead)).toContain("TARGET_VAULT_ONLY");
  expect(JSON.stringify(childRead)).not.toContain("ROOT_VAULT_ONLY");
  expect(child.getEntries()).toContainEqual(
    expect.objectContaining({
      type: "custom",
      customType: "native-compat",
      data: {
        phase: "settled",
        mode: "print",
        hasUI: false,
        trusted: true,
        cwd: target,
        active: expect.arrayContaining(["notes"]),
        registered: expect.not.arrayContaining(["subagent"]),
      },
    }),
  );
  const childDispatch = settledDispatches.find((dispatch) => dispatch.cwd === target);
  expect(childDispatch).toBeDefined();
  expect(childDispatch?.runner).not.toBe(parent.extensionRunner);
  expect(childDispatch?.paths).toContain(join(repo, ".pi/extensions/general/dist/index.js"));
  expect(parent.getActiveToolNames()).toContain("subagent");
  expect(
    parent.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "native-compat")
      .at(-1),
  ).toEqual(
    expect.objectContaining({
      type: "custom",
      customType: "native-compat",
      data: expect.objectContaining({
        phase: "settled",
        mode: "print",
        hasUI: false,
        registered: expect.arrayContaining(["notes", "subagent"]),
      }),
    }),
  );
  expect(writes.mock.calls.flatMap(([chunk]) => [...Buffer.from(String(chunk))])).not.toContain(
    0x07,
  );

  // Explicit built TUI-mode dispatch control, not a real interactive TUI.
  const writeBoundary = writes.mock.calls.length;
  vi.stubEnv("TMUX", undefined);
  vi.stubEnv("TMUX_PANE", undefined);
  await parent.bindExtensions({ mode: "tui" });
  await parent.extensionRunner.emit({ type: "agent_settled", aborted: false });
  expect(
    writes.mock.calls
      .slice(writeBoundary)
      .flatMap(([chunk]) => [...Buffer.from(String(chunk))])
      .filter((byte) => byte === 0x07),
  ).toHaveLength(1);
}, 30000);

// Only inference is scripted. Both sessions load native resources and execute real tools.
it.each(["on", "only"] as const)(
  "delegates through native codemode (%s) without recursive delegation",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "pi-native-delegation-"));
    const cleanup = testCleanup();
    cleanup(() => rmSync(root, { recursive: true, force: true }));
    cleanup(() => vi.unstubAllEnvs());
    const agentDir = join(root, "agent");
    const target = join(root, "target");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const evidenceDir = process.env.PI_ENV_NATIVE_TOOL_ARTIFACT_DIR ?? tmpdir();
    mkdirSync(evidenceDir, { recursive: true });
    const artifact = join(mkdtempSync(join(evidenceDir, "pi-native-delegation-")), "result.json");
    const evidence: Record<string, unknown> = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()
          .length > 0,
      repeat: "nub run build && nub run test:workflows",
      input: {
        mode,
        actions: ["run", "start", "wait", "result"],
        childTools: "target-native defaults",
        cancellation: "parent abort during a nested child tool",
      },
      expected:
        "Children use their own codemode without recursive delegation. Nested usage is reported once. Parent abort reaches the child tool, which settles cooperatively.",
      verdict: "failed",
    };
    let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
    const operations: Promise<unknown>[] = [];
    cleanup(
      () => parent?.abort(),
      () => parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
      () => settleOperations(operations),
      () => parent?.dispose(),
      () => {
        writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n");
      },
      () => {
        console.info(`Native delegation evidence: ${artifact}`);
      },
    );
    try {
      mkdirSync(agentDir);
      mkdirSync(target);
      writeFileSync(join(root, "identity.txt"), "parent identity must not leak");
      writeFileSync(join(target, "identity.txt"), "child-native identity");
      const childCode = `text(await tools.read({path: "identity.txt"})); text({parentTool: ALL_TOOLS.some(t => t.name === "parent_only"), delegation: ALL_TOOLS.some(t => t.name === "subagent")}); let blocked = false; try { await tools.subagent({action:"run",name:"recursive",task:"must not run"}); } catch (error) { blocked = true; text("recursive call blocked: " + error.message); } if (!blocked) throw Error("recursive delegation was allowed");`;
      const parentCode = `text(await tools.subagent({action:"run",name:"blocking",task:"child task",cwd:${JSON.stringify(target)}})); const started = await tools.subagent({action:"start",name:"background",task:"child task",cwd:${JSON.stringify(target)}}); const id = started.match(/Started subagent job ([\\w-]+)/)?.[1]; if (!id) throw Error(started); text(await tools.subagent({action:"wait",job_id:id})); text(await tools.subagent({action:"result",job_id:id}));`;
      const cancelCode = `text(await tools.subagent({action:"run",name:"cancelled",task:"blocked task",cwd:${JSON.stringify(target)}}));`;
      const provider = join(agentDir, "provider.mjs");
      writeFileSync(
        provider,
        `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
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
}`,
      );
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({
          extensions: [provider, bundle],
          defaultProvider: "native-delegation",
          defaultModel: "faux-1",
          defaultTools: ["+codemode"],
          codemode: { mode },
        }),
      );
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({ providers: { "native-delegation": { apiKey: "fixture-key" } } }),
      );
      const services = await createAgentSessionServices({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }),
        resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
        resourceLoaderOptions: {
          extensionFactories: [
            createCodemodeExtension(),
            (pi) => {
              pi.registerTool({
                name: "parent_only",
                label: "Parent only",
                description: "Parent-private fixture",
                parameters: { type: "object", properties: {} },
                execute: async () => ({
                  content: [{ type: "text", text: "parent only" }],
                  details: undefined,
                }),
              });
            },
          ],
        },
      });
      parent = (
        await createAgentSessionFromServices({
          services,
          sessionManager: SessionManager.create(root, join(root, "sessions")),
        })
      ).session;
      await parent.bindExtensions({ mode: "print" });
      const declaration = parent.getToolDefinition("subagent");
      expect(declaration).toBeDefined();
      evidence.delegationDeclaration = {
        description: declaration!.description,
        parameters: declaration!.parameters,
      };
      expect(declaration!.description).toContain("native-delegation/faux-1");
      expect(declaration!.description).not.toContain("parent_only");
      await parent.prompt("launch");
      const parentCodeResults = parent.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "codemode",
      );
      evidence.parentCodeResults = parentCodeResults;
      expect(parentCodeResults).toHaveLength(1);
      const result = parentCodeResults[0];
      if (result?.role !== "toolResult") throw new Error("Missing parent codemode result");
      evidence.parentResult = result;
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.content)).toContain("child complete");
      const childDirectory = join(
        parent.sessionManager.getSessionDir(),
        "_children",
        parent.sessionId,
      );
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
        const codeResult = codeResults[0];
        if (codeResult?.role !== "toolResult") throw new Error("Missing child codemode result");
        expect(codeResult.isError).toBe(false);
        expect(JSON.stringify(codeResult)).toContain("child-native identity");
        expect(JSON.stringify(codeResult)).not.toContain("parent identity must not leak");
        expect(JSON.stringify(codeResult)).toContain('\\"parentTool\\":false');
        expect(JSON.stringify(codeResult)).toContain('\\"delegation\\":false');
        expect(JSON.stringify(codeResult)).toContain("recursive call blocked:");
        const rejected = messages.find(
          (message) => message.role === "toolResult" && message.toolName === "subagent",
        );
        expect(rejected?.role === "toolResult" && rejected.isError).toBe(true);
        expect(child.getEntries()).toContainEqual(
          expect.objectContaining({
            type: "custom",
            customType: "delegation-loadout",
            data: {
              active: expect.arrayContaining(["codemode"]),
              registered: expect.not.arrayContaining(["subagent", "parent_only"]),
            },
          }),
        );
      }
      expect(Object.values(usage).reduce((total, count) => total + count, 0)).toBeGreaterThan(0);
      expect(result.usage).toEqual(expect.objectContaining(usage));
      const cancellationStarted = performance.now();
      const cancellationMessageStart = parent.messages.length;
      let cancellationFinished = false;
      const cancelled = parent.prompt("cancel").then(() => {
        cancellationFinished = true;
        evidence.cancellationFinishedAfterMs = performance.now() - cancellationStarted;
        evidence.cancellationOutput = parent?.messages.slice(cancellationMessageStart);
      });
      operations.push(cancelled);
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
      evidence.cancellationSettled = true;
      evidence.verdict = "passed";
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  },
  30000,
);
