import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import initSubagent from "../index";
import { RegisteredServiceFixture } from "./registered-service.fixture";

// Only inference is scripted. Public start/wait/list/result calls exercise real
// service-owned native children, durable job history and character pagination.
it("pages public results without erasing completed jobs or truncating native history", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-retention-"));
  const agentDir = join(root, "agent");
  const service = new RegisteredServiceFixture(agentDir);
  const fullOutput = "λ".repeat(9000) + "Complete native transcript ending";
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    await mkdir(agentDir);
    const extension = join(agentDir, "provider.mjs");
    await writeFile(extension, `import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
 const p=fauxProvider({provider:'retention-native'}); pi.registerProvider(p.provider);
 pi.on('input',event=>{
  p.setResponses(event.text.startsWith('job:') ? [fauxAssistantMessage(fauxToolCall('subagent',JSON.parse(event.text.slice(4))),{stopReason:'toolUse'}),fauxAssistantMessage('Parent settled')] : [fauxAssistantMessage(${JSON.stringify(fullOutput)})]);
 });
}`);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "retention-native", defaultModel: "faux-1", retry: { enabled: false } }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "retention-native": { apiKey: "fixture-key" } } }));
    new ProjectTrustStore(agentDir).set(root, true);
    await service.start();
    const services = await createAgentSessionServices({ cwd: root, agentDir, resourceLoaderOptions: { extensionFactories: [initSubagent] } });
    parent = (await createAgentSessionFromServices({ services, tools: ["subagent"], sessionManager: SessionManager.create(root, join(root, "sessions")) })).session;
    await parent.bindExtensions({ mode: "print" });
    const session = parent;
    const request = async (params: Record<string, unknown>) => {
      await session.prompt(`job:${JSON.stringify(params)}`);
      const result = session.messages.filter((message) => message.role === "toolResult").at(-1);
      expect(result).toBeDefined();
      return result!;
    };
    const ids: string[] = [];
    const completedDetails: unknown[] = [];
    for (let index = 0; index < 3; index++) {
      const started = await request({ action: "start", name: `bounded-${index}`, task: "bounded output", tools: [] });
      const { jobId: id } = Schema.decodeUnknownSync(Schema.Struct({ jobId: Schema.String }))(started.details);
      ids.push(id);
      const result = await request({ action: "wait", job_id: id, limit: 128 });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.details).toMatchObject({ resultTruncated: true });
      const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      expect(output).toBe(`${fullOutput.slice(0, 128)}\n\n[characters 0-128/${fullOutput.length}; next offset=128 ]`);
      expect(output).not.toContain("\uFFFD");
      expect(output).not.toContain("Complete native transcript ending");
      completedDetails.push(result.details);
      const first = await request({ action: "result", job_id: id });
      expect(first.details).toMatchObject({ resultTruncated: true });
      expect(first.content[0]).toMatchObject({ text: `${fullOutput.slice(0, 4096)}\n\n[characters 0-4096/${fullOutput.length}; next offset=4096 ]` });
      const rest = await request({ action: "result", job_id: id, offset: 4096, limit: 16384 });
      expect(rest.details).toMatchObject({ resultTruncated: true });
      expect(rest.content[0]).toMatchObject({ text: `${fullOutput.slice(4096)}\n\n[characters 4096-${fullOutput.length}/${fullOutput.length} ]` });
      const all = await request({ action: "result", job_id: id, limit: 16384 });
      expect(all.details).toMatchObject({ resultTruncated: false });
      expect(all.content[0]).toMatchObject({ text: expect.stringContaining(fullOutput) });
    }
    const listed = await request({ action: "list" });
    expect(listed.details).toMatchObject({ count: 3 });
    const listText = JSON.stringify(listed.content);
    expect(listText).toContain(ids[2]);
    expect(listText).toContain(ids[0]);
    expect(listText).toContain(ids[1]);
    const oldest = await request({ action: "result", job_id: ids[0], limit: 16384 });
    expect(oldest.isError).not.toBe(true);
    expect(oldest.content[0]).toMatchObject({ text: expect.stringContaining(fullOutput) });
    const retained = await request({ action: "result", job_id: ids[2] });
    expect(retained.details).toMatchObject({ resultTruncated: true });
    for (const limit of [0, 16385]) {
      const invalid = await request({ action: "result", job_id: ids[0], limit });
      expect(invalid.isError).toBe(true);
    }
    for (const details of completedDetails) {
      const { sessionFile: file, usage } = Schema.decodeUnknownSync(Schema.Struct({
        sessionFile: Schema.String,
        usage: Schema.Struct({ turns: Schema.Number }),
      }))(details);
      expect(usage.turns).toBeGreaterThan(0);
      const persisted = SessionManager.open(file).getEntries();
      expect(persisted.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "text" && block.text === fullOutput))).toBe(true);
      expect(await readFile(file, "utf8")).toContain("Complete native transcript ending");
    }
  } finally {
    try {
      await parent?.abort();
      await parent?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      parent?.dispose();
    } finally {
      vi.unstubAllEnvs();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30000);
