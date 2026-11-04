import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import * as Control from "../control";
import * as ChildTypes from "../child-types";
import { runResolvedSubagentEffect } from "../execute";
import { testCleanup } from "./cleanup";

// Only inference is scripted; private tool invocation and persistence use real SDK sessions.
it("keeps private tools run-local and retains native owners for isolated human input", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-private-tools-"));
  const cleanup = testCleanup();
  cleanup(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const target = join(root, "target");
  const submissionPath = join(target, "task-submission.json");
  const submission = { verdict: "complete" };
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  cleanup(
    () => (parent ? Control.disposeSubagentRunSupervisor(parent.sessionId) : undefined),
    () => parent?.abort(),
    () => parent?.dispose(),
    () => vi.unstubAllEnvs(),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  await mkdir(agentDir);
  await mkdir(join(target, ".pi"), { recursive: true });
  const providerPath = join(agentDir, "provider.mjs");
  await writeFile(
    providerPath,
    `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
  const p = fauxProvider({provider:'private-tool-fixture'});
  pi.registerProvider(p.provider);
  pi.on('input', event => {
    p.setResponses(event.text === 'Submit privately' ? [
      fauxAssistantMessage(fauxToolCall('submit_private_task', ${JSON.stringify(submission)}), {stopReason:'toolUse'}),
      fauxAssistantMessage('Initial task submitted')
    ] : [fauxAssistantMessage('Human or sibling complete')]);
  });
}`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "private-tool-fixture": { apiKey: "synthetic-not-a-secret" },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [providerPath],
      defaultProvider: "private-tool-fixture",
      defaultModel: "faux-1",
      defaultTools: ["read"],
    }),
  );
  await writeFile(join(target, "AGENTS.md"), "Target context for native private tools.");
  const services = await createAgentSessionServices({
    cwd: target,
    agentDir,
    settingsManager: SettingsManager.create(target, agentDir, { projectTrusted: true }),
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
  });
  parent = (
    await createAgentSessionFromServices({
      services,
      tools: ["read"],
      sessionManager: SessionManager.create(target, join(root, "sessions")),
    })
  ).session;
  await parent.bindExtensions({ mode: "print" });
  const before = {
    messages: structuredClone(parent.messages),
    model: parent.model,
    tools: parent.getActiveToolNames(),
  };
  const privateTool: ToolDefinition = {
    name: "submit_private_task",
    label: "Submit private task",
    description: "Persist this run's submission",
    parameters: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await writeFile(submissionPath, JSON.stringify(params));
      return {
        content: [{ type: "text", text: "Task submission persisted" }],
        details: { path: submissionPath },
      };
    },
  };
  const ctx = { cwd: target, sessionManager: parent.sessionManager, isProjectTrusted: () => true };
  const initial = await Effect.runPromise(
    runResolvedSubagentEffect(
      {
        name: "private-task",
        task: "Submit privately",
        cwd: target,
        toolNames: [privateTool.name],
        customTools: [privateTool],
      },
      ctx,
    ),
  );
  const supervisor = Control.getSubagentRunSupervisor(parent.sessionId)!;
  const child = [...supervisor.children.values()][0];
  expect(initial.details).toMatchObject({ isError: false, finalOutput: "Initial task submitted" });
  expect(JSON.parse(await readFile(submissionPath, "utf8"))).toEqual(submission);
  expect(child.inspect().systemPrompt).toContain("Target context");
  expect(child.inspect().activeTools).toEqual([privateTool.name]);
  expect(await readFile(child.summary().sessionFile!, "utf8")).toContain(
    "Task submission persisted",
  );

  await Effect.runPromise(
    runResolvedSubagentEffect({ name: "sibling", task: "Sibling", cwd: target }, ctx),
  );
  const sibling = [...supervisor.children.values()].find(
    (owner) => owner.summary().name === "sibling",
  )!;
  expect(sibling.inspect().activeTools).toContain("read");
  expect(sibling.inspect().callableTools).not.toContain(privateTool.name);
  await Effect.runPromise(
    runResolvedSubagentEffect(
      { name: "empty", task: "No tools", cwd: target, toolNames: [], customTools: [privateTool] },
      ctx,
    ),
  );
  const empty = [...supervisor.children.values()].find(
    (owner) => owner.summary().name === "empty",
  )!;
  expect(empty.inspect().activeTools).toEqual([]);
  expect(empty.inspect().callableTools).toEqual([]);

  const initialResult = structuredClone(child.inspect().initialResult);
  await child.input("Human continuation\nkeep original result", ChildTypes.NativeInputMode.Prompt);
  expect(child.inspect().inputs.at(-1)).toMatchObject({
    source: "human",
    mode: "prompt",
    text: "Human continuation\nkeep original result",
  });
  expect(await readFile(child.summary().sessionFile!, "utf8")).toContain(
    "Human or sibling complete",
  );
  expect(child.inspect().initialResult).toEqual(initialResult);
  expect({
    messages: parent.messages,
    model: parent.model,
    tools: parent.getActiveToolNames(),
  }).toEqual(before);
  expect(parent.getActiveToolNames()).not.toContain(privateTool.name);
  await Control.disposeSubagentRunSupervisor(parent.sessionId);
  for (const owner of [child, sibling, empty]) expect(owner.summary().state).toBe("closed");
  await expect(child.input("must not run", ChildTypes.NativeInputMode.Prompt)).rejects.toThrow(
    /closed/,
  );
}, 30_000);
