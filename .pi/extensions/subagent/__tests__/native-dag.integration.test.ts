import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  ProjectTrustStore,
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
import { RegisteredServiceFixture } from "./registered-service.fixture";
import {
  connectSubagentService,
  waitForOperation,
  type SubagentServiceConnection,
} from "../service-host";
import * as DagRuntime from "../../subagent/dag-runtime";
import * as ChildTypes from "../../subagent/child-types";

// Inference is scripted; tools load from the trusted target, not submission callbacks.
it("dispatches native target tools through the registered DAG service and retains children", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-private-dag-"));
  const agentDir = join(root, "agent");
  const target = join(root, "target");
  const runId = "private-task-native";
  const submissionPath = join(target, "task-submission.json");
  const submission = { verdict: "complete", findings: [], snapshot: "fixture-input" };
  let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  let service: DagRuntimeService.ActiveDagRuntimeService | undefined;
  let unsubscribe: (() => void) | undefined;
  let connection: SubagentServiceConnection | undefined;
  const host = new RegisteredServiceFixture(agentDir);
  const failures: unknown[] = [];
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    await mkdir(agentDir);
    await mkdir(join(target, ".pi"), { recursive: true });
    const providerPath = join(agentDir, "provider.ts");
    await writeFile(
      providerPath,
      `import { registerNativeDagFixture } from ${JSON.stringify(fileURLToPath(new URL("./native-dag-provider.fixture.ts", import.meta.url)))};
export default function(pi) {
  registerNativeDagFixture(pi, ${JSON.stringify(submissionPath)}, ${JSON.stringify(submission)});
}`,
    );
    // Native disk configuration and synthetic credentials isolate provider selection.
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "dag-task-fixture": { apiKey: "synthetic-not-a-secret" },
          "dag-default-fixture": { apiKey: "synthetic-not-a-secret" },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: [providerPath],
        defaultProvider: "dag-default-fixture",
        defaultModel: "faux-1",
        defaultTools: ["read"],
      }),
    );
    await writeFile(
      join(target, ".pi", "settings.json"),
      JSON.stringify({ defaultTools: ["read"] }),
    );
    await writeFile(join(target, "AGENTS.md"), "Target context for native DAG integration.");

    new ProjectTrustStore(agentDir).set(target, true);
    await host.start();
    const observeRuntime = (pi: ExtensionAPI) => {
      unsubscribe = DagRuntimeService.listenForDagRuntimeService(pi, (registration) => {
        service = registration.service;
      });
    };
    const services = await createAgentSessionServices({
      cwd: target,
      agentDir,
      settingsManager: SettingsManager.create(target, agentDir, { projectTrusted: true }),
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
      resourceLoaderOptions: { extensionFactories: [observeRuntime, initSubagent] },
    });
    parent = (
      await createAgentSessionFromServices({
        services,
        tools: ["read"],
        sessionManager: SessionManager.create(target, join(root, "sessions")),
      })
    ).session;
    await parent.bindExtensions({ mode: "print" });
    expect(service).toBeDefined();
    const runtime = service!;
    expect(runtime.closeChildren).toBeTypeOf("function");
    connection = await connectSubagentService(parent.sessionId, agentDir);
    const parentBefore = {
      messages: structuredClone(parent.messages),
      model: parent.model,
      tools: parent.getActiveToolNames(),
    };
    const validated = validateDagDefinition({
      runId,
      concurrency: 1,
      nodes: [
        {
          id: "task-submission",
          dependencies: [],
          executor: {
            kind: DagExecutorKind.Subagent,
            key: DagRuntime.DagSubagentExecutorKey,
            payload: {
              v: 1,
              name: "private-task",
              instructions: "Submit the task using the native submission tool.",
              model: "dag-task-fixture/faux-1",
              tools: ["submit_native_task"],
              workspace: { cwd: target, access: "read" },
              context: { outputs: [] },
              output: { name: "task_result" },
            },
          },
        },
        {
          id: "tool-free-default",
          dependencies: [{ nodeId: "task-submission", mode: DagDependencyMode.Required }],
          executor: {
            kind: DagExecutorKind.Subagent,
            key: DagRuntime.DagSubagentExecutorKey,
            payload: {
              v: 1,
              name: "tool-free-default",
              instructions: "Return a tool-free answer.",
              model: "dag-default-fixture/faux-1",
              tools: [],
              maxTurns: 1,
              workspace: { cwd: target, access: "read" },
              context: { outputs: [] },
              output: { name: "tool_free_result" },
            },
          },
        },
      ],
    });
    expect(validated._tag, JSON.stringify(validated)).toBe(DagValidationResultTag.Valid);
    if (validated._tag !== DagValidationResultTag.Valid) throw new Error(JSON.stringify(validated));
    const handle = await Effect.runPromise(
      runtime.submit(validated.graph, { workspaceRoot: target }),
    );
    await Effect.runPromise(handle.accepted);
    await Effect.runPromise(handle.await);
    expect(JSON.parse(await readFile(submissionPath, "utf8"))).toEqual(submission);
    const initialDag = await Effect.runPromise(runtime.reconstruct(runId));
    expect(initialDag.state.nodes.map((entry) => entry.status)).toEqual([
      DagNodeStatus.Succeeded,
      DagNodeStatus.Succeeded,
    ]);
    const node = initialDag.state.nodes[0];
    expect(node.status).toBe(DagNodeStatus.Succeeded);
    if (node.status !== DagNodeStatus.Succeeded) throw new Error(JSON.stringify(initialDag));
    const reference = node.outputs.task_result;
    expect(reference).toBeDefined();
    if (
      !reference ||
      typeof reference !== "object" ||
      !("path" in reference) ||
      typeof reference.path !== "string"
    ) {
      throw new Error(`Missing DAG text artifact: ${JSON.stringify(reference)}`);
    }
    const artifactRoot = join(
      parent.sessionManager.getSessionDir(),
      "dag-artifacts",
      parent.sessionId,
    );
    expect(await readFile(join(artifactRoot, reference.path), "utf8")).toBe(
      "Initial task submitted",
    );

    const children = connection.view.snapshot.value.children;
    expect(children).toHaveLength(2);
    const child = children.find((owner) => owner.name === "private-task")!;
    const toolFree = children.find((owner) => owner.name === "tool-free-default")!;
    const inspection = await connection.inspect(child.childId);
    const toolFreeInspection = await connection.inspect(toolFree.childId);
    const childSnapshot = inspection.snapshot.value!;
    const toolFreeSnapshot = toolFreeInspection.snapshot.value!;
    inspection.release();
    toolFreeInspection.release();
    expect(toolFreeSnapshot.model).toBe("dag-default-fixture/faux-1");
    expect(toolFreeSnapshot.activeTools).toEqual([]);
    expect(toolFreeSnapshot.callableTools).toEqual([]);
    expect(toolFreeSnapshot.initialResult).toMatchObject({
      isError: false,
      finalOutput: "Native default without tools",
      usage: { turns: 1 },
    });
    const toolFreeTranscript = await readFile(toolFree.sessionFile!, "utf8");
    expect(toolFreeTranscript.match(/"customType":"fixture-provider-request"/g)).toHaveLength(1);
    expect(childSnapshot.model).toBe("dag-task-fixture/faux-1");
    expect(childSnapshot.activeTools).toEqual(["submit_native_task"]);
    expect(childSnapshot.systemPrompt).toContain("Target context");
    expect(childSnapshot.state).toBe("idle");
    const initialResult = structuredClone(childSnapshot.initialResult);
    expect(initialResult?.isError).toBe(false);
    expect(initialResult?.finalOutput).toBe("Initial task submitted");
    const childFile = child.sessionFile!;
    expect(await readFile(childFile, "utf8")).toContain("Task submission persisted");
    const receipt = await connection.view.input({
      requestId: "human-continuation",
      childId: child.childId,
      text: "Human continuation\nkeep original DAG result",
      mode: ChildTypes.NativeInputMode.Prompt,
      source: "human",
    });
    await waitForOperation(connection, receipt.operationId);
    expect(await readFile(childFile, "utf8")).toContain("Human continuation complete");
    const continuedInspection = await connection.inspect(child.childId);
    const continued = continuedInspection.snapshot.value!;
    continuedInspection.release();
    expect(continued.inputs.at(-1)).toMatchObject({
      source: "human",
      mode: "prompt",
      text: "Human continuation\nkeep original DAG result",
    });
    expect(continued.initialResult).toEqual(initialResult);
    expect(JSON.parse(await readFile(submissionPath, "utf8"))).toEqual(submission);
    expect(await Effect.runPromise(runtime.reconstruct(runId))).toEqual(initialDag);
    expect(await readFile(join(artifactRoot, reference.path), "utf8")).toBe(
      "Initial task submitted",
    );
    expect({
      messages: parent.messages,
      model: parent.model,
      tools: parent.getActiveToolNames(),
    }).toEqual(parentBefore);

    // Closing the run owner must precede removing any target/artifact resources.
    await runtime.closeChildren(runId);
    for (const retained of [child, toolFree]) {
      const closed = await connection.inspect(retained.childId);
      expect(closed.snapshot.value!.state).toBe("closed");
      closed.release();
    }
    await expect(
      connection.view.input({
        requestId: "closed-input",
        childId: child.childId,
        text: "must not run after close",
        mode: "prompt",
        source: "human",
      }),
    ).rejects.toThrow(/closed/);
  } catch (cause) {
    failures.push(cause);
  } finally {
    const cleanup = [
      () => service?.closeChildren?.(runId),
      () => parent?.abort(),
      () => parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
      () => parent?.dispose(),
      () => connection?.close(),
      () => host.close(),
      () => unsubscribe?.(),
      () => vi.unstubAllEnvs(),
    ];
    for (const release of cleanup) {
      try {
        await release();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length === 0) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      console.error(`Native DAG failure evidence (synthetic inputs only): ${root}`);
      throw new AggregateError(failures, "Native DAG operation or cleanup failed");
    }
  }
}, 30_000);
