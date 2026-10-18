import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Effect } from "effect";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Execute from "../execute";
import * as ChildTypes from "../child-types";
import * as Control from "../control";
import * as Config from "../config";
import * as ChildContext from "../../_shared/child-context";

function execute(...args: Parameters<typeof Execute.runResolvedSubagentEffect>) {
  return ChildContext.withChildContext({ cwd: args[0].cwd, agentDir: join(args[0].cwd, "agent") }, () =>
    Effect.runPromise(Execute.runResolvedSubagentEffect(...args)),
  );
}

// Only inference is synthetic: a disk-loaded target provider exercises native discovery,
// model selection, hooks, dispatch and persistence without a parent registry or loop seam.
it("owns target configuration, tools, input provenance and persisted followups", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-child-"));
  let child: ChildTypes.NativeChildSession | undefined;
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    const extension = join(root, ".pi", "provider.mjs");
    const ai = import.meta.resolve("@earendil-works/pi-ai");
    await writeFile(
      extension,
      `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(ai)};
export default function(pi) {
 const p = fauxProvider({provider:'child-only'});
 p.setResponses([fauxAssistantMessage(fauxToolCall('read',{path:'identity.txt'}),{stopReason:'toolUse'}),fauxAssistantMessage('initial complete'),fauxAssistantMessage('human complete')]);
 pi.registerProvider(p.provider);
 pi.on('input', (event) => { pi.appendEntry('input-hook', {text:event.text,source:event.source}); if (event.text === 'handled human') return {action:'handled'}; });
}`,
    );
    await writeFile(join(root, "identity.txt"), "target identity");
    await writeFile(join(root, "AGENTS.md"), "Native project context marker");
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({
        extensions: [extension],
        defaultProvider: "child-only",
        defaultModel: "faux-1",
        defaultTools: ["read"],
      }),
    );
    const parent = SessionManager.create(root, join(root, "sessions"));
    const ctx = {
      cwd: root,
      sessionManager: parent,
      isProjectTrusted: () => true,
    };
    const result = await execute(
      {
        name: "native",
        task: "read identity",
        cwd: root,
        modelOverride: "child-only/faux-1",
        systemPrompt: "Delegated instruction",
      },
      ctx,
      {
        onChild: (value) => {
          child = value;
        },
      },
    );
    expect(result.details.isError).toBe(false);
    expect(result.details.finalOutput).toContain("initial complete");
    expect(child!.inspect().systemPrompt).toContain("Delegated instruction");
    expect(child!.inspect().systemPrompt).toContain("Native project context marker");
    expect(child!.inspect().model).toBe("child-only/faux-1");
    expect(child!.inspect().messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        content: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("target identity") }),
        ]),
      }),
    );
    expect(await child!.input("verbatim human", ChildTypes.NativeInputMode.Prompt)).toEqual({ outcome: "started" });
    expect(child!.inspect().initialResult).toEqual(result.details);
    expect(child!.inspect().inputs.map((i) => i.source)).toEqual(["coordinator", "human"]);
    expect(await child!.input("handled human", ChildTypes.NativeInputMode.Prompt)).toEqual({ outcome: "handled" });
    const reopened = SessionManager.open(child!.inspect().sessionFile!);
    expect(reopened.buildSessionContext().messages).toEqual(child!.inspect().messages);
    expect(reopened.getEntries()).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "input-hook",
        data: { text: "verbatim human", source: "interactive" },
      }),
    );
    expect(parent.buildSessionContext().messages).toEqual([]);
    await expect(child!.input("invalid idle steer", ChildTypes.NativeInputMode.Steer)).rejects.toThrow();
  } finally {
    await child?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("queues native steering/followup and close waits a cooperative tool before releasing ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-child-active-"));
  let child: ChildTypes.NativeChildSession | undefined;
  const { Type } = await import("typebox");
  const supervisor = new Control.SubagentRunSupervisor("native-test", Config.resolveSubagentRuntimeConfig({}));
  const blocker = await supervisor.acquire({
    runId: "blocker",
    cwd: root,
    workspaceAccess: Control.WorkspaceAccess.Write,
  });
  let retained!: () => void;
  const retention = new Promise<void>((resolve) => {
    retained = resolve;
  });
  let enter!: () => void;
  let release!: () => void;
  let aborted!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sawAbort = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    const extension = join(root, ".pi", "provider.mjs");
    await writeFile(
      extension,
      `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
 const p = fauxProvider({provider:'gated-child'});
 p.setResponses([fauxAssistantMessage(fauxToolCall('gate',{}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
 pi.registerProvider(p.provider);
 pi.on('input', event => { pi.appendEntry('input-hook', {text:event.text,source:event.source}); });
 pi.on('session_shutdown', () => { pi.appendEntry('shutdown-hook',{}); });
}`,
    );
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ extensions: [extension] }),
    );
    const ctx = {
      cwd: root,
      sessionManager: SessionManager.create(root, join(root, "sessions")),
      isProjectTrusted: () => true,
    };
    const running = execute(
      {
        name: "gated",
        task: "run gate",
        cwd: root,
        modelOverride: "gated-child/faux-1",
        toolNames: ["gate"],
        customTools: [
          {
            name: "gate",
            label: "Gate",
            description: "Cooperative gated test tool",
            parameters: Type.Object({}),
            async execute(_id, _params, signal) {
              signal?.addEventListener("abort", aborted, { once: true });
              enter();
              await gate;
              return { content: [{ type: "text", text: "settled" }], details: {} };
            },
          },
        ],
      },
      ctx,
      {
        supervisor,
        onChild: (value) => {
          child = value;
          retained();
        },
      },
    );
    await retention;
    expect(child!.inspect().state).toBe("queued");
    await expect(child!.input("not yet streaming", ChildTypes.NativeInputMode.Prompt)).rejects.toThrow();
    blocker.release();
    await entered;
    expect(await child!.input("steer verbatim", ChildTypes.NativeInputMode.Steer)).toEqual({ outcome: "queued" });
    expect(await child!.input("follow verbatim", ChildTypes.NativeInputMode.FollowUp)).toEqual({ outcome: "queued" });
    await expect(child!.input("overlap", ChildTypes.NativeInputMode.Prompt)).rejects.toThrow();
    let closed = false;
    const closing = child!.close().then(() => {
      closed = true;
    });
    await sawAbort;
    let competingAdmitted = false;
    const competing = supervisor
      .acquire({ runId: "competing", cwd: root, workspaceAccess: Control.WorkspaceAccess.Write })
      .then((lease) => {
        competingAdmitted = true;
        lease.release();
      });
    await Promise.resolve();
    expect(competingAdmitted).toBe(false);
    expect(closed).toBe(false);
    expect(child!.inspect().state).toBe("closing");
    await expect(child!.input("too late", ChildTypes.NativeInputMode.Prompt)).rejects.toThrow();
    release();
    await closing;
    await running;
    await competing;
    expect(child!.inspect().state).toBe("closed");
    await child!.close();
    const entries = SessionManager.open(child!.inspect().sessionFile!).getEntries();
    expect(
      entries.filter((e) => e.type === "custom" && e.customType === "shutdown-hook"),
    ).toHaveLength(1);
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "input-hook",
        data: { text: "steer verbatim", source: "interactive" },
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "input-hook",
        data: { text: "follow verbatim", source: "interactive" },
      }),
    );
  } finally {
    blocker.release();
    release?.();
    await child?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("rejects unavailable explicit model/tools and treats [] as no tools, not native defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-child-selection-"));
  const children: ChildTypes.NativeChildSession[] = [];
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await mkdir(join(root, "agent"));
    // Native default selection uses configured availability before async auth refresh.
    await writeFile(join(root, "agent", "models.json"), JSON.stringify({ providers: { "selection-child": { apiKey: "fixture-key" } } }));
    const extension = join(root, ".pi", "provider.mjs");
    await writeFile(
      extension,
      `import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { writeFileSync } from 'node:fs';
export default function(pi) { const p = fauxProvider({provider:'selection-child'}); p.setResponses([fauxAssistantMessage('complete')]); pi.registerProvider(p.provider); pi.on('session_start',()=>{ writeFileSync(${JSON.stringify(join(root, "started"))},'started'); pi.registerTool({name:'late_fixture',label:'Late native tool',description:'Registered by the supported native startup hook',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'late native result'}],details:{}}}}); }); }`,
    );
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({
        extensions: [extension],
        defaultProvider: "selection-child",
        defaultModel: "faux-1",
        defaultTools: ["read"],
      }),
    );
    const ctx = {
      cwd: root,
      sessionManager: SessionManager.create(root, join(root, "sessions")),
      isProjectTrusted: () => true,
    };
    const run = (overrides: Partial<Parameters<typeof Execute.runResolvedSubagentEffect>[0]>) =>
      execute({ name: "selection", task: "respond", cwd: root, ...overrides }, ctx, {
        onChild: (c) => children.push(c),
      });
    await expect(run({ modelOverride: "selection-child/faux" })).rejects.toThrow("unavailable");
    await expect(run({ toolNames: ["r*"] })).rejects.toThrow("unavailable");
    expect(existsSync(join(root, "started"))).toBe(false);
    await expect(run({ toolNames: ["not_a_tool"] })).rejects.toThrow();
    // Exact availability follows necessary native discovery. Startup hooks may
    // have run, but the invalid selection never starts a model turn.
    expect(existsSync(join(root, "started"))).toBe(true);
    const empty = await run({ toolNames: [] });
    expect(empty.details.isError, JSON.stringify(empty)).toBe(false);
    expect(existsSync(join(root, "started"))).toBe(true);
    expect(children.at(-1)!.inspect().activeTools).toEqual([]);
    expect(children.at(-1)!.inspect().callableTools).toEqual([]);
    const late = await run({ toolNames: ["late_fixture"] });
    expect(late.details.isError, JSON.stringify(late)).toBe(false);
    expect(children.at(-1)!.inspect().activeTools).toEqual(["late_fixture"]);
    expect(children.at(-1)!.inspect().callableTools).toEqual(["late_fixture"]);
    const defaults = await run({});
    expect(defaults.details.isError, JSON.stringify(defaults)).toBe(false);
    // Native defaults activate newly registered direct tools at session startup.
    expect(children.at(-1)!.inspect().activeTools).toEqual(["read", "late_fixture"]);
    expect(children.slice(0, 3).every((c) => c.inspect().state === "closed")).toBe(true);
  } finally {
    await Promise.all(children.map((c) => c.close()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
