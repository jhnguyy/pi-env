import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as ChildContext from "../../_shared/child-context";
import * as SessionRuntime from "../session-runtime";
import { settleOperations, testCleanup } from "./cleanup";

// The marker comes from a real native tool observing abort, not just a supervisor timer.
it.each(["deadline", "shutdown"] as const)(
  "settles cooperative native work on %s",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "native-root-limits-"));
    const cleanup = testCleanup();
    cleanup(() => rmSync(root, { recursive: true, force: true }));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    cleanup(() => vi.unstubAllEnvs());
    const runtime = new SessionRuntime.SubagentSessionRuntime({
      appendEntry: () => {},
      events: { emit: () => {} },
    } as any);
    const operations: Promise<unknown>[] = [];
    cleanup(
      () => runtime.shutdownSession(),
      () => settleOperations(operations),
    );
    mkdirSync(join(root, ".pi"));
    const extension = join(root, ".pi", "provider.mjs");
    writeFileSync(
      extension,
      `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
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
}`,
    );
    writeFileSync(
      join(root, ".pi", "settings.json"),
      JSON.stringify({
        extensions: [extension],
        subagent: {
          maxConcurrentRuns: 1,
          maxPendingRuns: 1,
          maxRunMs: mode === "deadline" ? 1000 : 10000,
        },
      }),
    );
    const ctx: any = {
      cwd: root,
      sessionManager: SessionManager.create(root, join(root, "sessions")),
      isProjectTrusted: () => true,
    };
    await ChildContext.withChildContext({ cwd: root, agentDir: join(root, "agent") }, async () => {
      await runtime.startSession(ctx);
      const params = {
        name: "bounded",
        task: "wait",
        model: "bounded/faux-1",
        tools: ["wait_for_abort"],
      };
      const running = runtime.execute("active", params, undefined, undefined, ctx);
      operations.push(running);
      await expect.poll(() => existsSync(join(root, "entered"))).toBe(true);
      if (mode === "shutdown") {
        const queued = runtime.execute("queued", params, undefined, undefined, ctx);
        operations.push(queued);
        await expect
          .poll(() => runtime.listChildren().filter((child) => child.state === "queued").length)
          .toBe(1);
        const rejected = await runtime.execute("overflow", params, undefined, undefined, ctx);
        expect(rejected.details.isError).toBe(true);
        expect(rejected.details.stopReason).toContain("admission");
        // No deadline has fired: shutdown must cancel the held active lease and its queue.
        expect(existsSync(join(root, "aborted"))).toBe(false);
        await runtime.shutdownSession();
        expect((await queued).details.isError).toBe(true);
      }
      expect((await running).details.isError).toBe(true);
      expect(existsSync(join(root, "aborted"))).toBe(true);
      await runtime.shutdownSession();
      expect(runtime.listChildren()).toEqual([]);
      expect(runtime.usageText()).toBe("No subagent usage recorded.");
      expect(
        (await runtime.execute("late", params, undefined, undefined, ctx)).details.stopReason,
      ).toBe("inactive");
    });
  },
  15000,
);
