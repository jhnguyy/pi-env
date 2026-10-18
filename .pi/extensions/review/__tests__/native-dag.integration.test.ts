import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ToolDefinition,
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
import * as Control from "../../subagent/control";
import * as DagRuntime from "../../subagent/dag-runtime";
import * as ChildTypes from "../../subagent/child-types";

// The unavailable boundary is inference only. This deliberately uses a minimal
// review submission authority rather than runReviewDag's full pinned Git snapshot,
// evidence resolver and multi-role synthesis fixture. It covers the shared native
// handoff/retention contract, not review plan validation or synthesis semantics.
it("dispatches run-local review authority through the real DAG and retains its native child", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-review-dag-"));
  const agentDir = join(root, "agent");
  const target = join(root, "target");
  const runId = "private-review-native";
  const submissionPath = join(target, "review-submission.json");
  const submission = { verdict: "approve", findings: [], snapshot: "fixture-snapshot" };
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
        fauxAssistantMessage(fauxToolCall('submit_private_review', ${JSON.stringify(submission)}), {stopReason:'toolUse'}),
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
    expect(parent.getActiveToolNames()).not.toContain("submit_private_review");
    const parentBefore = { messages: structuredClone(parent.messages), model: parent.model, tools: parent.getActiveToolNames() };
    const privateTool: ToolDefinition = {
      name: "submit_private_review",
      label: "Submit private review",
      description: "Persist the submission for this review run only",
      parameters: { type: "object", properties: { verdict: { type: "string" }, findings: { type: "array", items: { type: "string" } }, snapshot: { type: "string" } }, required: ["verdict", "findings", "snapshot"], additionalProperties: false },
      async execute(_id, params) {
        await writeFile(submissionPath, JSON.stringify(params));
        return { content: [{ type: "text", text: "Review submission persisted" }], details: { path: submissionPath } };
      },
    };
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
            tools: [privateTool.name],
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
    const handle = await Effect.runPromise(runtime.submit(validated.graph, { workspaceRoot: target, customTools: [privateTool] }));
    await Effect.runPromise(handle.accepted);
    await Effect.runPromise(handle.await);
    expect(JSON.parse(await readFile(submissionPath, "utf8"))).toEqual(submission);
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

    const supervisor = Control.getSubagentRunSupervisor(parent.sessionId)!;
    expect(supervisor.children.size).toBe(2);
    const child = [...supervisor.children.values()].find((owner) => owner.summary().name === "private-review")!;
    const toolFree = [...supervisor.children.values()].find((owner) => owner.summary().name === "tool-free-default")!;
    expect(toolFree.inspect().model).toBe("dag-default-fixture/faux-1");
    expect(toolFree.inspect().activeTools).toEqual([]);
    expect(toolFree.inspect().callableTools).toEqual([]);
    expect(toolFree.inspect().initialResult).toMatchObject({ isError: false, finalOutput: "Native default without tools", usage: { turns: 1 } });
    expect(child.inspect().model).toBe("dag-review-fixture/faux-1");
    expect(child.inspect().activeTools).toEqual([privateTool.name]);
    expect(child.inspect().systemPrompt).toContain("Pinned review target context");
    expect(child.summary().state).toBe("idle");
    const initialResult = structuredClone(child.inspect().initialResult);
    expect(initialResult?.isError).toBe(false);
    expect(initialResult?.finalOutput).toBe("Initial review submitted");
    const childFile = child.summary().sessionFile!;
    expect(await readFile(childFile, "utf8")).toContain("Review submission persisted");
    await child.input("Human continuation\nkeep original DAG result", ChildTypes.NativeInputMode.Prompt);
    expect(await readFile(childFile, "utf8")).toContain("Human continuation complete");
    expect(child.inspect().inputs.at(-1)).toMatchObject({ source: "human", mode: "prompt", text: "Human continuation\nkeep original DAG result" });
    expect(child.inspect().initialResult).toEqual(initialResult);
    expect(await Effect.runPromise(runtime.reconstruct(runId))).toEqual(initialDag);
    expect(await readFile(join(artifactRoot, reference.path), "utf8")).toBe("Initial review submitted");
    expect({ messages: parent.messages, model: parent.model, tools: parent.getActiveToolNames() }).toEqual(parentBefore);

    // Closing the run owner must precede removing any target/artifact resources.
    await runtime.closeChildren!(runId);
    expect(child.summary().state).toBe("closed");
    expect(toolFree.summary().state).toBe("closed");
    await expect(child.input("must not run after close", ChildTypes.NativeInputMode.Prompt)).rejects.toThrow(/closed/);
    passed = true;
  } finally {
    await service?.closeChildren?.(runId);
    await parent?.abort();
    await parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    parent?.dispose();
    unsubscribe?.();
    vi.unstubAllEnvs();
    if (passed) await rm(root, { recursive: true, force: true });
    else console.error(`Native DAG failure evidence (synthetic inputs only): ${root}`);
  }
}, 30_000);
