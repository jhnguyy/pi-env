import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import {
  DagExecutorKind,
  DagDependencyMode,
  DagNodeStatus,
  DagValidationResultTag,
  validateDagDefinition,
} from "../../../../src/dag/index.js";
import * as DagRuntimeService from "../../_shared/dag-runtime-service";
import initSubagent from "../../subagent/index";
import { connectSubagentService, waitForOperation, type SubagentServiceConnection } from "../../subagent/service-host";
import { reviewFixture } from "./fixtures/review-flow";
import { reviewDagToolNames } from "../dag-tools";
import { resolveReviewCapability } from "../../../../src/subagent-service/review-capability";
import * as DagRuntime from "../../subagent/dag-runtime";
import { RegisteredServiceFixture } from "../../subagent/__tests__/registered-service.fixture";


// Inference is synthetic; capability reconstruction, DAG dispatch and native
// child retention use the production service. Full synthesis has a separate fixture.
it("dispatches run-local review authority through the real DAG and retains its native child", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-review-dag-"));
  const agentDir = join(root, "agent");
  const daemon = new RegisteredServiceFixture(agentDir);
  const target = join(root, "target");
  const runId = "private-review-native";
  const fixture = reviewFixture();
  const names = reviewDagToolNames(fixture.state.snapshot.id);
  const deck = await readFile(fixture.deckPath, "utf8");
  const capability = {
    kind: "review-v1" as const, reviewId: fixture.state.snapshot.id, runId,
    snapshot: { ...fixture.state.snapshot, worktree: target },
    deckPath: fixture.deckPath, artifactRoot: fixture.artifactRoot,
    evidence: {
      v: 1 as const, snapshotId: fixture.state.snapshot.id, worktree: target,
      headOid: fixture.state.snapshot.metadata.headOid, diffHash: fixture.state.snapshot.diffHash,
      diffPath: fixture.state.snapshot.diffPath, changedPaths: ["a.ts"],
      planOutputName: "plan", reviewerContextWindow: 272_000,
    },
  };
  let connection: SubagentServiceConnection | undefined;
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  let service: DagRuntimeService.ActiveDagRuntimeService | undefined;
  let unsubscribe: (() => void) | undefined;
  let passed = false;
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    await mkdir(agentDir);
    await mkdir(join(target, ".pi"), { recursive: true });
    const providerPath = join(agentDir, "provider.mjs");
    await writeFile(providerPath, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
  const p = fauxProvider({provider:'dag-review-fixture'});
  pi.registerProvider(p.provider);
  const defaults = fauxProvider({provider:'dag-default-fixture'});
  defaults.setResponses([fauxAssistantMessage('Native default without tools')]);
  pi.registerProvider(defaults.provider);
  pi.on('input', event => {
    if (event.text === 'Human continuation\\nkeep original DAG result') {
      p.setResponses([fauxAssistantMessage('Human continuation complete')]);
    } else {
      p.setResponses([
        fauxAssistantMessage(fauxToolCall(${JSON.stringify(names.deck)}, {}), {stopReason:'toolUse'}),
        fauxAssistantMessage('Initial review submitted')
      ]);
    }
  });
}`);
    // Native disk configuration and synthetic credentials; no ambient provider or
    // credential selection. The private tool is NOT registered in these resources.
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "dag-review-fixture": { apiKey: "synthetic-not-a-secret" }, "dag-default-fixture": { apiKey: "synthetic-not-a-secret" } } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [providerPath], defaultProvider: "dag-default-fixture", defaultModel: "faux-1", defaultTools: ["read"] }));
    await writeFile(join(target, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
    await writeFile(join(target, "AGENTS.md"), "Pinned review target context for native DAG integration.");

    const observeRuntime = (pi: ExtensionAPI) => {
      unsubscribe = DagRuntimeService.listenForDagRuntimeService(pi, registration => { service = registration.service; });
    };
    await daemon.start();
    const services = await createAgentSessionServices({
      cwd: target,
      agentDir,
      settingsManager: SettingsManager.create(target, agentDir, { projectTrusted: true }),
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
      resourceLoaderOptions: { extensionFactories: [observeRuntime, initSubagent] },
    });
    parent = (await createAgentSessionFromServices({ services, tools: ["read"], sessionManager: SessionManager.create(target, join(root, "sessions")) })).session;
    await parent.bindExtensions({ mode: "print" });
    expect(service).toBeDefined();
    const runtime = service!;
    expect(runtime.closeChildren).toBeTypeOf("function");
    expect(parent.getActiveToolNames()).not.toContain(names.deck);
    connection = await connectSubagentService(parent.sessionId);
    const parentBefore = { messages: structuredClone(parent.messages), model: parent.model, tools: parent.getActiveToolNames() };
    await expect(resolveReviewCapability({ capability: { ...capability, callback: () => {} }, runId, cwd: target })).rejects.toThrow(/data|authority/);
    await expect(resolveReviewCapability({ capability, runId: "wrong-run", cwd: target })).rejects.toThrow(/mismatched/);
    await expect(resolveReviewCapability({ capability, runId, cwd: root })).rejects.toThrow(/mismatched/);
    const validated = validateDagDefinition({
      runId,
      concurrency: 1,
      nodes: [{
        id: "review-submission",
        dependencies: [],
        executor: {
          kind: DagExecutorKind.Subagent,
          key: DagRuntime.DagSubagentExecutorKey,
          payload: {
            v: 1,
            name: "private-review",
            instructions: "Submit the pinned review using the private submission tool.",
            model: "dag-review-fixture/faux-1",
            tools: [names.deck],
            workspace: { cwd: target, access: "read" },
            context: { outputs: [] },
            output: { name: "review_result" },
          },
        },
      }, {
        id: "tool-free-default",
        dependencies: [{ nodeId: "review-submission", mode: DagDependencyMode.Required }],
        executor: {
          kind: DagExecutorKind.Subagent,
          key: DagRuntime.DagSubagentExecutorKey,
          payload: {
            v: 1, name: "tool-free-default", instructions: "Return a tool-free answer.", model: "dag-default-fixture/faux-1",
            tools: [], maxTurns: 1, workspace: { cwd: target, access: "read" },
            context: { outputs: [] }, output: { name: "tool_free_result" },
          },
        },
      }],
    });
    expect(validated._tag, JSON.stringify(validated)).toBe(DagValidationResultTag.Valid);
    if (validated._tag !== DagValidationResultTag.Valid) throw new Error(JSON.stringify(validated));
    await expect(Effect.runPromise(runtime.submit(validated.graph, { customTools: [{ execute() {} } as never] }))).rejects.toThrow(/custom|ToolDefinitions/);
    const handle = await Effect.runPromise(runtime.submit(validated.graph, { workspaceRoot: target, reviewCapability: capability }));
    await Effect.runPromise(handle.accepted);
    await Effect.runPromise(handle.await);

    const initialDag = await Effect.runPromise(runtime.reconstruct(runId));
    const node = initialDag.state.nodes[0];
    expect(node.status).toBe(DagNodeStatus.Succeeded);
    if (node.status !== DagNodeStatus.Succeeded) throw new Error(JSON.stringify(initialDag));
    const reference = node.outputs.review_result;
    expect(reference).toBeDefined();
    if (!reference || typeof reference !== "object" || !("path" in reference) || typeof reference.path !== "string") {
      throw new Error(`Missing DAG text artifact: ${JSON.stringify(reference)}`);
    }
    const artifactRoot = join(parent.sessionManager.getSessionDir(), "dag-artifacts", parent.sessionId);
    expect(await readFile(join(artifactRoot, reference.path), "utf8")).toBe("Initial review submitted");

    const children = connection.view.snapshot.value.children.filter(child => child.runId === runId);
    expect(children).toHaveLength(2);
    const child = children.find(child => child.name === "private-review")!;
    const toolFree = children.find(child => child.name === "tool-free-default")!;
    const inspection = await connection.inspect(child.childId);
    const toolFreeInspection = await connection.inspect(toolFree.childId);
    await inspection.refresh({});
    await toolFreeInspection.refresh({});
    expect(toolFreeInspection.snapshot.value?.model).toBe("dag-default-fixture/faux-1");
    expect(toolFreeInspection.snapshot.value?.activeTools).toEqual([]);
    expect(toolFreeInspection.snapshot.value?.callableTools).toEqual([]);
    expect(toolFreeInspection.snapshot.value?.initialResult).toMatchObject({ isError: false, finalOutput: "Native default without tools", usage: { turns: 1 } });
    expect(inspection.snapshot.value?.model).toBe("dag-review-fixture/faux-1");
    expect(inspection.snapshot.value?.activeTools).toEqual([names.deck]);
    expect(inspection.snapshot.value?.systemPrompt).toContain("Pinned review target context");
    expect(child.state).toBe("idle");
    const initialResult = structuredClone(inspection.snapshot.value?.initialResult);
    expect(initialResult?.isError).toBe(false);
    expect(initialResult?.finalOutput).toBe("Initial review submitted");
    const childFile = child.sessionFile!;
    expect(await readFile(childFile, "utf8")).toContain(JSON.stringify(deck).slice(1, -1));
    // Dropping the parent connection must not dispose accepted native sessions.
    await connection.close();
    connection = await connectSubagentService(parent.sessionId);
    const continued = await connection.view.input({ requestId: "human-continuation", childId: child.childId, mode: "prompt", source: "human", text: "Human continuation\nkeep original DAG result" });
    await waitForOperation(connection, continued.operationId);
    const refreshed = await connection.inspect(child.childId);
    await refreshed.refresh({});
    expect(await readFile(childFile, "utf8")).toContain("Human continuation complete");
    expect(refreshed.snapshot.value?.inputs.at(-1)).toMatchObject({ source: "human", mode: "prompt", text: "Human continuation\nkeep original DAG result" });
    expect(refreshed.snapshot.value?.initialResult).toEqual(initialResult);
    expect(await Effect.runPromise(runtime.reconstruct(runId))).toEqual(initialDag);
    expect(await readFile(join(artifactRoot, reference.path), "utf8")).toBe("Initial review submitted");
    expect({ messages: parent.messages, model: parent.model, tools: parent.getActiveToolNames() }).toEqual(parentBefore);

    // Closing the run owner must precede removing any target/artifact resources.
    await runtime.closeChildren(runId);
    await expect(connection.view.input({ requestId: "after-close", childId: child.childId, mode: "prompt", source: "human", text: "must not run after close" })).rejects.toThrow(/closed/);
    passed = true;
  } finally {
    try {
      await service?.closeChildren(runId);
      await connection?.close();
      await parent?.abort();
      await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      parent?.dispose();
    } finally {
      unsubscribe?.();
      vi.unstubAllEnvs();
      await daemon.close();
      if (passed) await rm(root, { recursive: true, force: true });
      else console.error(`Native DAG failure evidence (synthetic inputs only): ${root}`);
    }
  }
}, 30_000);
