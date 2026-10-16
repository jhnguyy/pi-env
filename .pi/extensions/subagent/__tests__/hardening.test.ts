import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as ChildContext from "../../_shared/child-context";
import * as SessionRuntime from "../session-runtime";

// Real time is deliberately bounded here: this proves native abort reaches a cooperative
// tool, not merely that an isolated supervisor timer flips an AbortSignal.
it("bounds native root admission and settles active and pending children on timeout and shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-root-limits-"));
  const runtime = new SessionRuntime.SubagentSessionRuntime({ appendEntry: () => {}, events: { emit: () => {} } } as any);
  try {
    mkdirSync(join(root, ".pi"));
    const extension = join(root, ".pi", "provider.mjs");
    writeFileSync(extension, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { writeFileSync } from 'node:fs';
export default function(pi) {
 const p = fauxProvider({provider:'bounded'});
 p.setResponses([fauxAssistantMessage(fauxToolCall('wait_for_abort',{}),{stopReason:'toolUse'}),fauxAssistantMessage('settled')]);
 pi.registerProvider(p.provider);
 pi.registerTool({name:'wait_for_abort',label:'Wait',description:'Cooperative test wait',parameters:{type:'object',properties:{}},
 async execute(id,params,signal) {
   writeFileSync(${JSON.stringify(join(root, "entered"))},'entered');
   await new Promise(resolve => { if(signal.aborted) resolve(); else signal.addEventListener('abort',resolve,{once:true}); });
   writeFileSync(${JSON.stringify(join(root, "aborted"))},'aborted');
   return {content:[{type:'text',text:'settled'}],details:{}};
 }});
}`);
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ extensions: [extension], subagent: { maxConcurrentRuns: 1, maxPendingRuns: 1, maxRunMs: 1000 } }));
    const ctx: any = { cwd: root, sessionManager: SessionManager.create(root, join(root, "sessions")), isProjectTrusted: () => true };
    await ChildContext.withChildContext({ cwd: root, agentDir: join(root, "agent") }, async () => {
      await runtime.startSession(ctx);
      const params = { name: "bounded", task: "wait", model: "bounded/faux-1", tools: ["wait_for_abort"] };
      const running = runtime.execute("timed", params, undefined, undefined, ctx);
      await expect.poll(() => existsSync(join(root, "entered"))).toBe(true);
      const queued = runtime.execute("queued", params, undefined, undefined, ctx);
      await expect.poll(() => runtime.listChildren().filter(child => child.state === "queued").length).toBe(1);
      const rejected = await runtime.execute("overflow", params, undefined, undefined, ctx);
      expect(rejected.details.isError).toBe(true);
      expect(rejected.details.stopReason).toContain("admission");
      const timed = await running;
      expect(timed.details.isError).toBe(true);
      expect(existsSync(join(root, "aborted"))).toBe(true);
      await runtime.shutdownSession();
      expect((await queued).details.isError).toBe(true);
      expect(runtime.listChildren()).toEqual([]);
      expect(runtime.usageText()).toBe("No subagent usage recorded.");
      expect((await runtime.execute("late", params, undefined, undefined, ctx)).details.stopReason).toBe("inactive");
    });
  } finally {
    await runtime.shutdownSession();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
