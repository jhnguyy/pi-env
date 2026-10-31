import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import * as SessionRuntime from "../session-runtime";
import { RegisteredServiceFixture } from "./registered-service.fixture";

// Real native tools distinguish explicit cancellation from a parent disconnect.
// Admission bounds belong to control.test and the service multiprocess workflow.
it("cancels explicitly but preserves accepted work and history across parent disconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-root-limits-"));
  const agentDir = join(root, "agent");
  const service = new RegisteredServiceFixture(agentDir);
  const runtime = new SessionRuntime.SubagentSessionRuntime({ appendEntry: () => {}, events: { emit: () => {} } } as any);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    mkdirSync(agentDir);
    const extension = join(agentDir, "provider.mjs");
    writeFileSync(extension, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { existsSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
export default function(pi) {
 const p = fauxProvider({provider:'bounded'});
 pi.registerProvider(p.provider);
 pi.on('input', event => p.setResponses([fauxAssistantMessage(fauxToolCall('wait_for_release',{name:event.text}),{stopReason:'toolUse'}),fauxAssistantMessage('settled:'+event.text)]));
 pi.registerTool({name:'wait_for_release',label:'Wait',description:'Cooperative test wait',parameters:{type:'object',properties:{name:{type:'string'}},required:['name']},
 async execute(id,params,signal) {
   writeFileSync(root+'/entered-'+params.name,'entered');
   while(!existsSync(root+'/release-'+params.name) && !signal.aborted) await new Promise(resolve=>setTimeout(resolve,5));
   if(signal.aborted) writeFileSync(root+'/aborted-'+params.name,'aborted');
   return {content:[{type:'text',text:'settled'}],details:{}};
 }});
}`);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "bounded", defaultModel: "faux-1", retry: { enabled: false } }));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { bounded: { apiKey: "synthetic-local-only" } } }));
    new ProjectTrustStore(agentDir).set(root, true);
    const ctx: any = { cwd: root, sessionManager: SessionManager.create(root, join(root, "sessions")), isProjectTrusted: () => true };
    await service.start();
    await runtime.startSession(ctx);
    const params = { name: "bounded", model: "bounded/faux-1", tools: ["wait_for_release"] };
    const controller = new AbortController();
    const running = runtime.execute("explicit-cancel", { ...params, task: "cancel" }, controller.signal, undefined, ctx);
    try {
      await expect.poll(() => existsSync(join(root, "entered-cancel"))).toBe(true);
    } finally { controller.abort(); }
    const cancelled = await running;
    expect(cancelled.details.isError).toBe(true);
    expect(existsSync(join(root, "aborted-cancel"))).toBe(true);

    const started = await runtime.startJob({ ...params, task: "survive" }, ctx);
    const id = started.details.jobId!;
    await expect.poll(() => existsSync(join(root, "entered-survive"))).toBe(true);
    await runtime.shutdownSession();
    expect(runtime.listChildren()).toEqual([]);
    await runtime.startSession(ctx);
    expect(runtime.getJob(id)?.status).toBe("running");
    expect(existsSync(join(root, "aborted-survive"))).toBe(false);
    writeFileSync(join(root, "release-survive"), "release");
    expect((await runtime.waitJob(id)).job?.status).toBe("completed");
    expect(await runtime.resultJob(id)).toMatchObject({ text: "settled:survive", truncated: false });
    await runtime.shutdownSession();
    await runtime.startSession(ctx);
    expect(runtime.getJob(id)?.status).toBe("completed");
    expect(await runtime.resultJob(id)).toMatchObject({ text: "settled:survive" });
  } finally {
    writeFileSync(join(root, "release-cancel"), "release");
    writeFileSync(join(root, "release-survive"), "release");
    try { await runtime.shutdownSession(); }
    finally {
      vi.unstubAllEnvs();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30000);
