import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as ChildContext from "../../_shared/child-context";
import type { ResolvedSubagentRun } from "../execution-types";
import { NativeChildOwner } from "../native-child";
import * as ChildTypes from "../child-types";
import * as Config from "../config";
import * as Control from "../control";
import { settleOperations, testCleanup } from "./cleanup";

// The service uses this same owner. Direct construction exposes startup rollback
// and input-preflight races that serialized public requests cannot coordinate.
async function fixture(body: string, maxRunMs = 5000) {
  const root = await mkdtemp(join(tmpdir(), "native-lifecycle-"));
  const cleanup = testCleanup();
  cleanup(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi"));
  await mkdir(join(root, "agent"));
  await writeFile(join(root, "agent", "models.json"), JSON.stringify({ providers: { "lifecycle-provider": { apiKey: "fixture-key" } } }));
  const extension = join(root, ".pi", "provider.mjs");
  await writeFile(extension, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
export default function(pi) {
 const root = ${JSON.stringify(root)};
 const p = fauxProvider({provider:'lifecycle-provider'});
 p.setResponses([fauxAssistantMessage('initial')]); pi.registerProvider(p.provider);
 ${body}
}`);
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "lifecycle-provider", defaultModel: "faux-1" }));
  const supervisor = new Control.SubagentRunSupervisor("lifecycle", Config.resolveSubagentRuntimeConfig({ maxRunMs }));
  cleanup(() => supervisor.shutdown());
  const context = { cwd: root, isProjectTrusted: () => true };
  let child: ChildTypes.NativeChildSession | undefined;
  cleanup(() => writeFile(join(root, "release"), "release"), () => child?.close());
  return {
    root, supervisor, cleanup,
    child: () => child!,
    execute: (run: Partial<ResolvedSubagentRun> = {}) => {
      const owner = ChildContext.withChildContext({ cwd: root, agentDir: join(root, "agent") }, () => new NativeChildOwner(
        { name: "lifecycle", task: "initial", cwd: root, ...run }, context,
        SessionManager.create(root, join(root, "sessions")), supervisor, {},
      ));
      child = owner;
      supervisor.retainChild(owner);
      return owner.runInitial();
    },
  };
}

it.each([
  { initial: true, cancellation: "close" },
  { initial: false, cancellation: "cancel" },
] as const)("prevents post-cancel native effects across input preflight: $initial / $cancellation", async ({ initial, cancellation }) => {
  const f = await fixture(`
 pi.registerTool({name:'effect',label:'Effect',description:'Record a test-owned effect',parameters:{type:'object',properties:{}},async execute() { writeFileSync(root+'/effect',''); return {content:[{type:'text',text:'effect'}],details:{}}; }});
 pi.on('input', async event => {
   if(event.text !== 'delayed input') return;
   writeFileSync(root+'/entered','');
   while(!existsSync(root+'/release')) await new Promise(resolve=>setTimeout(resolve,5));
   p.setResponses([fauxAssistantMessage(fauxToolCall('effect',{}),{stopReason:'toolUse'}),fauxAssistantMessage('post-cancel result')]);
 });
 pi.on('before_agent_start', event => { if(event.prompt === 'delayed input') writeFileSync(root+'/started',''); });
`);
  let work: Promise<unknown> | undefined;
  let cancellationWork: Promise<void> | undefined;
  f.cleanup(
    () => writeFile(join(f.root, "release"), "release"),
    () => settleOperations([work, cancellationWork]),
  );
  {
    if (initial) work = f.execute({ task: "delayed input" });
    else {
      expect((await f.execute()).details.isError).toBe(false);
      await expect(f.child().input("invalid idle steer", ChildTypes.NativeInputMode.Steer)).rejects.toThrow("requires a streaming child");
      work = f.child().input("delayed input", ChildTypes.NativeInputMode.Prompt);
    }
    await vi.waitFor(() => expect(existsSync(join(f.root, "entered"))).toBe(true));
    cancellationWork = f.child()[cancellation]();
    await writeFile(join(f.root, "release"), "release");
    await Promise.all([work, cancellationWork]);
    expect(existsSync(join(f.root, "started"))).toBe(false);
    expect(existsSync(join(f.root, "effect"))).toBe(false);
    if (initial) expect(f.child().inspect().initialResult?.isError).toBe(true);
    expect(f.child().summary().state).toBe(initial ? "closed" : "idle");
  }
}, 15000);

it.each(["model", "session"] as const)("unwinds loaded extension resources exactly once on %s startup failure", async (phase) => {
  const f = await fixture(`writeFileSync(root+'/opened',''); pi.on('session_shutdown', async () => { writeFileSync(root+'/closing',''); while(!existsSync(root+'/release')) await new Promise(resolve=>setTimeout(resolve,5)); appendFileSync(root+'/closed','closed\\n'); });`);
  const operations: Promise<unknown>[] = [];
  f.cleanup(() => writeFile(join(f.root, "release"), "release"), () => settleOperations(operations));
  {
    // A supplied descriptor that throws at the SDK boundary exercises construction failure
    // without replacing the SDK constructor or adding a production injection seam.
    const invalidTool = { get name(): string { throw new Error("supplied descriptor failed"); }, label: "Invalid", description: "Invalid fixture", parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } };
    const failed = expect(f.execute(phase === "model" ? { modelOverride: "unavailable/model" } : { customTools: [invalidTool] })).rejects.toThrow();
    operations.push(failed);
    await vi.waitFor(() => expect(existsSync(join(f.root, "closing"))).toBe(true));
    let competingAdmitted = false;
    const competing = f.supervisor.acquire({ cwd: f.root, workspaceAccess: Control.WorkspaceAccess.Write }).then((lease) => { competingAdmitted = true; lease.release(); });
    operations.push(competing);
    await Promise.resolve();
    expect(competingAdmitted).toBe(false);
    await writeFile(join(f.root, "release"), "release");
    await Promise.all([failed, competing]);
    expect(existsSync(join(f.root, "opened"))).toBe(true);
    expect(await readFile(join(f.root, "closed"), "utf8")).toBe("closed\n");
    expect(f.child().summary().state).toBe("closed");
    await f.child().close();
    expect(await readFile(join(f.root, "closed"), "utf8")).toBe("closed\n");
  }
});
