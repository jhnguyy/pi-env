import {
  AssistantEntry,
  configure,
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type EntryId,
  type ModelRef,
  type TaskId,
  type TaskOutcome,
} from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { DagDependencyMode } from "../dag/contracts.js";
import { TextMaxBytes, type WorkflowDefinition, type WorkflowNode } from "./definition.js";

export const NodeResultSchema = Type.Union([
  Type.Object(
    {
      id: Type.String(),
      status: Type.Literal("succeeded"),
      output: Type.String({ minLength: 1, maxLength: TextMaxBytes }),
      reason: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Type.String(),
      status: Type.Union([Type.Literal("failed"), Type.Literal("blocked")]),
      output: Type.Null(),
      reason: Type.String({ minLength: 1, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
]);
export type NodeResult = Static<typeof NodeResultSchema>;
const RunResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("degraded"),
      Type.Literal("failed"),
    ]),
    output: Type.Union([Type.String({ maxLength: TextMaxBytes }), Type.Null()]),
    nodes: Type.Array(NodeResultSchema, { maxItems: 16 }),
    segmentOutcome: Type.String(),
  },
  { additionalProperties: false },
);
export type RunResult = Static<typeof RunResultSchema>;
const ResultEntry = defineEntry<RunResult>("pi-env.workflow.result");
// Harness IDs encode as positive integers. The store/run/principal lookup, not the nominal type, proves membership.
const PositiveId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const RunReferenceSchema = Type.Object(
  {
    serviceId: Type.String({
      pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
    }),
    runId: Type.Unsafe<ConversationId>(PositiveId),
  },
  { additionalProperties: false },
);
export type RunReference = Static<typeof RunReferenceSchema>;
const NodeIdentitySchema = Type.Object(
  { id: Type.String(), taskId: Type.Unsafe<TaskId<NodeResult>>(PositiveId) },
  { additionalProperties: false },
);
export type NodeIdentity = Static<typeof NodeIdentitySchema>;
const RunMetadata = {
  reference: RunReferenceSchema,
  principal: Type.String(),
  workflow: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  segmentTaskId: Type.Unsafe<TaskId<null>>(PositiveId),
  completionTaskId: Type.Unsafe<TaskId<null>>(PositiveId),
  nodes: Type.Array(NodeIdentitySchema, { maxItems: 16 }),
};
const RunStateSchema = Type.Union([
  Type.Object(
    {
      ...RunMetadata,
      status: Type.Literal("running"),
      result: Type.Null(),
      resultEntryId: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...RunMetadata,
      status: Type.Literal("completed"),
      result: RunResultSchema,
      resultEntryId: Type.Unsafe<EntryId>(PositiveId),
    },
    { additionalProperties: false },
  ),
]);
export type RunState = Static<typeof RunStateSchema>;
export function readRun(value: unknown): RunState {
  if (!Check(RunStateSchema, value))
    throw new Error("invalid_run_state: stored run does not match this bundle");
  return value;
}

export const RunDoc = defineDoc<{ run: RunState | null }>({
  kind: "pi-env.workflow.run",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ run: null }),
  checkpointWhen: () => true,
});
export const CapacityDoc = defineDoc<{ active: ConversationId | null }>({
  kind: "pi-env.workflow.capacity",
  version: 1,
  scope: "session",
  initial: () => ({ active: null }),
  checkpointWhen: () => true,
});

type NodeInput = { node: WorkflowNode; text: string; model: ModelRef };
type NodeCheckpoint =
  | { phase: "dependencies" }
  | { phase: "prepare"; dependencies: TaskId<NodeResult>[] }
  | { phase: "submit"; conversationId: ConversationId; prompt: string };

export function nodeResult(id: string, outcome: TaskOutcome<unknown>): NodeResult {
  if (
    outcome.status === "completed" &&
    Check(NodeResultSchema, outcome.result) &&
    outcome.result.id === id
  )
    return outcome.result;
  return {
    id,
    status: "failed",
    output: null,
    reason: outcome.status === "completed" ? "invalid_result" : outcome.status,
  };
}

const AgentNode = defineTask<NodeInput, NodeCheckpoint, NodeResult>({
  name: "pi-env.workflow.agent",
  version: 1,
  initial: () => ({ phase: "dependencies" }),
  phases: {
    dependencies: async (task, runtime, context) => {
      const state = readRun((await runtime.snapshot(RunDoc, task.conversationId, context))?.run);
      const byId = new Map(state.nodes.map((node) => [node.id, node.taskId]));
      const dependencies = task.input.node.dependencies.map((dependency) => {
        const id = byId.get(dependency.nodeId);
        if (id === undefined) throw new Error("Missing committed dependency identity");
        return id;
      });
      await runtime.commit(
        () => ({
          status: "waiting",
          on: dependencies,
          policy: "allSettled",
          checkpoint: { phase: "prepare", dependencies },
        }),
        context,
      );
    },
    prepare: async (task, runtime, context) => {
      const outcomes = await runtime.outcomes(task.state.checkpoint.dependencies, context);
      const dependencies = task.input.node.dependencies.map((dependency, index) => ({
        mode: dependency.mode,
        ...nodeResult(dependency.nodeId, outcomes[index]),
      }));
      if (
        dependencies.some(
          (dependency) =>
            dependency.mode === DagDependencyMode.Required && dependency.status !== "succeeded",
        )
      ) {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                id: task.input.node.id,
                status: "blocked",
                output: null,
                reason: "required_dependency",
              },
            },
          }),
          context,
        );
        return;
      }
      const prompt = JSON.stringify({
        stage: task.input.node.id,
        input: task.input.text,
        dependencies,
      });
      if (Buffer.byteLength(prompt) > 64 * 1_024)
        throw new Error("Dependency context exceeds 64 KiB");
      await runtime.commit(async (tx) => {
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: task.id },
        });
        // No environment, tools, hooks, resource discovery, or nested-callable capabilities are installed.
        await configure(tx, conversation.id, {
          model: task.input.model,
          tools: [],
          modelTools: [],
          extensions: [],
          instructions: task.input.node.instructions,
        });
        return {
          status: "running",
          checkpoint: { phase: "submit", conversationId: conversation.id, prompt },
        };
      }, context);
    },
    submit: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint;
      const conversation = await runtime.conversation(checkpoint.conversationId, context);
      if (!conversation) throw new Error("Missing committed node conversation");
      const submission = await conversation.submit(
        {
          type: "input",
          content: checkpoint.prompt,
          requestId: `node:${task.id}`,
          whenBusy: "reject",
        },
        context,
      );
      const settled = await submission.wait(context);
      await conversation.waitForIdle(context);
      let result: NodeResult = {
        id: task.input.node.id,
        status: "failed",
        output: null,
        reason: settled.status === "unanswered" ? settled.reason.slice(0, 512) : "output_contract",
      };
      if (settled.status === "done" && settled.type === "input") {
        // The answer belongs to the node conversation, not to the run's transcript.
        const answer = await runtime.commit(async (tx) => {
          const entry = await tx.entry(AssistantEntry, settled.answer);
          const output = (entry?.model ?? [])
            .flatMap((message) =>
              message.role === "assistant"
                ? message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                : [],
            )
            .join("\n");
          if (output.trim().length > 0 && Buffer.byteLength(output) <= TextMaxBytes)
            result = { id: task.input.node.id, status: "succeeded", output, reason: null };
          return { status: "terminal", outcome: { status: "completed", result } };
        }, context);
        return answer;
      }
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result } }),
        context,
      );
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type SegmentInput = { definition: WorkflowDefinition; text: string; model: ModelRef };
type SegmentCheckpoint = { phase: "expand" } | { phase: "finish" };
export const SegmentTask = defineTask<SegmentInput, SegmentCheckpoint, null>({
  name: "pi-env.workflow.segment",
  version: 1,
  initial: () => ({ phase: "expand" }),
  phases: {
    expand: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const doc = await tx.doc(RunDoc, task.conversationId);
        if (!doc.run) throw new Error("Missing run state");
        const nodes: NodeIdentity[] = [];
        for (const node of task.input.definition.nodes) {
          const taskId = await tx.createTask(
            AgentNode,
            { node, text: task.input.text, model: task.input.model },
            { ownership: { kind: "task", taskId: task.id } },
          );
          nodes.push({ id: node.id, taskId });
        }
        doc.run.nodes = nodes;
        return {
          status: "waiting",
          on: nodes.map((node) => node.taskId),
          policy: "allSettled",
          checkpoint: { phase: "finish" },
        };
      }, context),
    finish: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

// This durable join owns permit release, including after a segment faults. A watch callback cannot release capacity.
export const CompletionTask = defineTask<
  { segmentTaskId: TaskId<null>; presenter: string },
  { phase: "join" } | { phase: "finish" },
  null
>({
  name: "pi-env.workflow.completion",
  version: 1,
  initial: () => ({ phase: "join" }),
  phases: {
    join: (task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "waiting",
          on: [task.input.segmentTaskId],
          policy: "allSettled",
          checkpoint: { phase: "finish" },
        }),
        context,
      ),
    finish: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const segment = await tx.task(task.input.segmentTaskId);
        if (segment?.state.status !== "terminal")
          throw new Error("Completion ran before its segment settled");
        const doc = await tx.doc(RunDoc, task.conversationId);
        const run = doc.run;
        if (!run) throw new Error("Missing run state");
        const nodes: NodeResult[] = [];
        for (const node of run.nodes) {
          const record = await tx.task(node.taskId);
          if (record?.state.status !== "terminal")
            throw new Error("Completion ran before owned work settled");
          nodes.push(nodeResult(node.id, record.state.outcome));
        }
        const presenter = nodes.find((node) => node.id === task.input.presenter);
        const status =
          segment.state.outcome.status !== "completed" || presenter?.status !== "succeeded"
            ? "failed"
            : nodes.every((node) => node.status === "succeeded")
              ? "succeeded"
              : "degraded";
        const result: RunResult = {
          status,
          output: presenter?.output ?? null,
          nodes,
          segmentOutcome: segment.state.outcome.status,
        };
        const capacity = await tx.doc(CapacityDoc);
        if (capacity.active !== task.conversationId)
          throw new Error("Run lost its capacity reservation");
        const entry = await tx.appendEntry(ResultEntry, task.conversationId, { data: result });
        doc.run = { ...run, result, resultEntryId: entry.id, status: "completed" };
        capacity.active = null;
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export const WorkflowTasks = defineExtension({
  name: "pi-env.workflow",
  tasks: [SegmentTask, AgentNode, CompletionTask],
});
