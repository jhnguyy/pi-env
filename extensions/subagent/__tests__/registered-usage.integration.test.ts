import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import initSubagent, { type SubagentToolParams } from "../index";
import { getSubagentRunSupervisor } from "../control";
import { NativeInputMode } from "../child-types";
import type { SubagentJobRenderDetails } from "../types";
import type { SubagentUsageSummary } from "../usage-accounting";
import { testCleanup } from "./cleanup";

it("accounts for native children across transport, follow-ups, cancellation, eviction and parent resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "registered-usage-"));
  const cleanup = testCleanup();
  cleanup(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  cleanup(() => vi.unstubAllEnvs());
  const sessions: AgentSession[] = [];
  cleanup(async () => {
    for (const session of sessions) {
      await session.abort();
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [fileURLToPath(new URL("./fixtures/usage.ts", import.meta.url))],
      defaultProvider: "usage-fixture",
      defaultModel: "faux-1",
      defaultTools: ["usage_gate"],
      subagent: { maxRetainedJobs: 1 },
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: { "usage-fixture": { apiKey: "fixture-key" } },
    }),
  );
  const received: SubagentJobRenderDetails[] = [];
  const open = async (manager: SessionManager) => {
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }),
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
      resourceLoaderOptions: {
        extensionFactories: [initSubagent, createCodemodeExtension({ mode: "on" })],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      tools: ["subagent", "codemode"],
      sessionManager: manager,
    });
    sessions.push(session);
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "subagent" && !event.isError)
        received.push(event.result.details as SubagentJobRenderDetails);
    });
    await session.bindExtensions({ mode: "print" });
    return session;
  };
  let parent = await open(SessionManager.create(root, join(root, "sessions")));
  const call = async (params: SubagentToolParams, nested = false, owner = parent) => {
    received.length = 0;
    await owner.prompt(`${nested ? "parent-code:" : "parent:"}${JSON.stringify(params)}`);
    await owner.waitForIdle();
    expect(received).toHaveLength(1);
    return received[0];
  };
  const usage = async (owner = parent): Promise<SubagentUsageSummary> => {
    const response = await call({ action: "usage" }, false, owner);
    expect(response.status).toBe("usage");
    expect(response.usageSummary).toBeDefined();
    return response.usageSummary!;
  };
  await call({ action: "run", name: "sync", task: "priced initial", tools: [] });
  const supervisor = getSubagentRunSupervisor(parent.sessionId)!;
  const sync = [...supervisor.children.values()][0];
  expect(sync.inspect().initialResult?.finalOutput).toBe("child settled");
  expect((await usage()).children.cost).toBeCloseTo(1.25);
  const fork = await open(
    SessionManager.forkFrom(parent.sessionManager.getSessionFile()!, root, join(root, "sessions")),
  );
  expect((await usage(fork)).children.cost).toBeCloseTo(1.25);
  await sync.input("priced followup", NativeInputMode.Prompt);
  expect((await usage()).children.cost).toBeCloseTo(3.75);
  expect((await usage(fork)).children.cost).toBeCloseTo(1.25);

  // The child has already spent on its tool-call turn while its gate is still running.
  const accepted = await call(
    {
      action: "start",
      name: "async",
      task: "priced gate",
      tools: ["usage_gate"],
    },
    true,
  );
  await vi.waitFor(() => expect(existsSync(join(root, "gate-entered"))).toBe(true));
  expect((await usage()).children.cost).toBeCloseTo(4.5);
  await call({ action: "cancel", job_id: accepted.jobId });
  await call({ action: "wait", job_id: accepted.jobId });
  const settled = await usage();
  expect(settled.children.cost).toBeCloseTo(4.5);
  expect(supervisor.children.has(sync.id)).toBe(false);
  await call({ action: "result", job_id: accepted.jobId });
  await call({ action: "result", job_id: accepted.jobId });
  const repeated = await usage();
  expect(repeated.children.cost).toBeCloseTo(settled.children.cost);
  expect(repeated.total.cost).toBeCloseTo(repeated.parent.cost + repeated.children.cost);
  // The query snapshot precedes the parent's final 0.3-cost answer.
  expect(parent.getSessionStats().cost).toBeCloseTo(repeated.parent.cost + 0.3);
  for (const message of parent.messages) {
    if (message.role === "toolResult" && ["subagent", "codemode"].includes(message.toolName))
      expect(message.usage).toBeUndefined();
  }

  const file = parent.sessionManager.getSessionFile()!;
  await parent.extensionRunner?.emit({ type: "session_shutdown", reason: "reload" });
  parent.dispose();
  sessions.splice(sessions.indexOf(parent), 1);
  parent = await open(SessionManager.open(file));
  const restored = await usage();
  expect(restored.children.cost).toBeCloseTo(4.5);
  expect(restored.childCount).toBe(2);
  expect(restored.unavailableChildren).toEqual([]);
  expect(restored.total.cost).toBeCloseTo(restored.parent.cost + 4.5);
});
