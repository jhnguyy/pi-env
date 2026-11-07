import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";
import initSubagent from "../index";
import * as Control from "../control";
import type * as ChildTypes from "../child-types";
import { testCleanup } from "./cleanup";

// Only inference is scripted. Public start/wait/list/result calls exercise real
// native children, job retention, byte bounding and persisted full conversations.
it("bounds completed public jobs and result bytes without truncating native history", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-retention-"));
  const cleanup = testCleanup();
  cleanup(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const fullOutput = "λλλλλ Native answer: useful text " + "λ".repeat(60) + "Complete native transcript ending";
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  cleanup(
    () => parent?.abort(),
    () => parent?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    () => parent?.dispose(),
    () => vi.unstubAllEnvs(),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  {
    await mkdir(agentDir);
    const extension = join(agentDir, "provider.mjs");
    await writeFile(extension, `import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
 const p=fauxProvider({provider:'retention-native'}); pi.registerProvider(p.provider);
 pi.on('input',event=>{
  p.setResponses(event.text.startsWith('job:') ? [fauxAssistantMessage(fauxToolCall('subagent',JSON.parse(event.text.slice(4))),{stopReason:'toolUse'}),fauxAssistantMessage('Parent settled')] : [fauxAssistantMessage(${JSON.stringify(fullOutput)})]);
 });
}`);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "retention-native", defaultModel: "faux-1", subagent: { maxRetainedJobs: 1, maxResultBytes: 128 } }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "retention-native": { apiKey: "fixture-key" } } }));
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
    const supervisor = Control.getSubagentRunSupervisor(parent.sessionId)!;
    const ids: string[] = [];
    const owners: ChildTypes.NativeChildSession[] = [];
    const answers: unknown[] = [];
    for (let index = 0; index < 2; index++) {
      const started = await request({ action: "start", name: `bounded-${index}`, task: "bounded output", tools: [] });
      const { jobId: id } = Schema.decodeUnknownSync(Schema.Struct({ jobId: Schema.String }))(started.details);
      ids.push(id);
      const result = await request({ action: "wait", job_id: id });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.details).toMatchObject({ resultTruncated: true });
      const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(128);
      expect(output).toContain("λλλλλ Native answer: useful text");
      expect(output).toContain("Output truncated");
      answers.push(result.content);
      expect(output).not.toContain("\uFFFD");
      expect(output).not.toContain("Complete native transcript ending");
      const { sessionFile: file } = Schema.decodeUnknownSync(Schema.Struct({ sessionFile: Schema.String }))(result.details);
      const persisted = SessionManager.open(file).getEntries();
      expect(persisted.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "text" && block.text === fullOutput))).toBe(true);
      owners.push([...supervisor.children.values()].at(-1)!);
    }
    const listed = await request({ action: "list" });
    expect(listed.details).toMatchObject({ count: 1 });
    const listText = JSON.stringify(listed.content);
    expect(listText).toContain(ids[1]);
    expect(listText).not.toContain(ids[0]);
    const removed = await request({ action: "result", job_id: ids[0] });
    expect(removed.isError).toBe(true);
    const retained = await request({ action: "result", job_id: ids[1] });
    expect(retained.content).toEqual(answers[1]);
    expect(retained.details).toMatchObject({ resultTruncated: true });
    await vi.waitFor(() => expect(supervisor.children.size).toBe(1));
    expect(owners[0].summary().state).toBe("closed");
    await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(owners[1].summary().state).toBe("closed");
  }
}, 30000);
