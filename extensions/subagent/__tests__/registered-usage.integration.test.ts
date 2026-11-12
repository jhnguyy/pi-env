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

function expectCosts(
  summary: SubagentUsageSummary,
  parent: number,
  children: number,
  total: number,
) {
  expect(summary.parent.cost).toBeCloseTo(parent, 8);
  expect(summary.children.cost).toBeCloseTo(children, 8);
  expect(summary.total.cost).toBeCloseTo(total, 8);
}

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
  // Parent prompts cost 0.2 before each tool and 0.3 after it. Child prices are independent.
  expectCosts(await usage(), 0.7, 1.25, 1.95);
  const fork = await open(
    SessionManager.forkFrom(parent.sessionManager.getSessionFile()!, root, join(root, "sessions")),
  );
  expectCosts(await usage(fork), 1.2, 1.25, 2.45);
  await sync.input("priced followup", NativeInputMode.Prompt);
  expectCosts(await usage(), 1.2, 3.75, 4.95);
  expectCosts(await usage(fork), 1.7, 1.25, 2.95);

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
  expectCosts(await usage(), 2.2, 4.5, 6.7);
  await call({ action: "cancel", job_id: accepted.jobId });
  await call({ action: "wait", job_id: accepted.jobId });
  expectCosts(await usage(), 3.7, 4.5, 8.2);
  expect(supervisor.children.has(sync.id)).toBe(false);
  await call({ action: "result", job_id: accepted.jobId });
  await call({ action: "result", job_id: accepted.jobId });
  expectCosts(await usage(), 5.2, 4.5, 9.7);
  // The query snapshot precedes the parent\'s final 0.3-cost answer.
  expect(parent.getSessionStats().cost).toBeCloseTo(5.5);

  const file = parent.sessionManager.getSessionFile()!;
  await parent.extensionRunner?.emit({ type: "session_shutdown", reason: "reload" });
  parent.dispose();
  sessions.splice(sessions.indexOf(parent), 1);
  parent = await open(SessionManager.open(file));
  const restored = await usage();
  expectCosts(restored, 5.7, 4.5, 10.2);
  expect(restored.childCount).toBe(2);
  expect(restored.unavailableChildren).toEqual([]);
});
