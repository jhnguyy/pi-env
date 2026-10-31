import { hostNamed, method, remote } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { NativeChildSnapshot } from "../../.pi/extensions/subagent/child-types.js";
import type { SubagentDetails } from "../../.pi/extensions/subagent/types.js";
const UsageSchema = Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), cost: Type.Number(), turns: Type.Number() }, { additionalProperties: false });
export type InitialMetadata = Omit<SubagentDetails, "task" | "finalOutput" | "usage" | "modelOverride"> & { modelOverride?: string; usage: Static<typeof UsageSchema> };

const Id = Type.String({ minLength: 1, maxLength: 256 });
const Text = Type.String({ maxLength: 16_384 });
const Prompt = Type.String({ minLength: 1, maxLength: 4 * 1024 * 1024 });
export const MaxServiceRequestBytes = 32 * 1024 * 1024;
const objectOptions = { additionalProperties: false } as const;
export const ScopeSchema = Type.Object({ parentSessionId: Id }, objectOptions);
export const SubmitSchema = Type.Object({
  requestId: Id, runId: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  task: Prompt,
  cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
  model: Type.Optional(Id), tools: Type.Optional(Type.Array(Id, { maxItems: 128 })),
  systemPrompt: Type.Optional(Type.String({ maxLength: 4 * 1024 * 1024 })),
  reasoning: Type.Optional(Type.Union([Type.Literal("max"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")])),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  workspaceAccess: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
  capability: Type.Optional(Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Unknown()))),
}, objectOptions);
export type Submit = Static<typeof SubmitSchema>;
export const InputSchema = Type.Object({
  requestId: Id, childId: Id,
  mode: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
  source: Type.Union([Type.Literal("coordinator"), Type.Literal("human")]),
  text: Type.String({ minLength: 1, maxLength: 16_384 }),
}, objectOptions);
export type Input = Static<typeof InputSchema>;
export const CancelSchema = Type.Object({ requestId: Id, operationId: Id }, objectOptions);
export type Cancel = Static<typeof CancelSchema>;
export const ReceiptSchema = Type.Object({ childId: Id, operationId: Id }, objectOptions);
export type Receipt = Static<typeof ReceiptSchema>;
export const OperationSchema = Type.Object({
  ...ReceiptSchema.properties, parentSessionId: Id, runId: Id, createdAt: Type.String(),
  kind: Type.Union([Type.Literal("initial"), Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
  status: Type.Union([Type.Literal("accepted"), Type.Literal("dispatched"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted")]),
  cancelRequested: Type.Boolean(),
}, objectOptions);
export type Operation = Static<typeof OperationSchema>;
export const ChildSchema = Type.Object({
  childId: Id, parentSessionId: Id, runId: Id, name: Type.String(), task: Type.String(), cwd: Type.String(),
  createdAt: Type.String(), sessionFile: Type.Union([Type.String(), Type.Null()]),
  model: Type.Optional(Type.String()),
  initialDetails: Type.Optional(Type.Unsafe<InitialMetadata>(Type.Object({}, { additionalProperties: true }))),
  usage: Type.Optional(UsageSchema),
  state: Type.Union([Type.Literal("historical"), Type.Literal("idle"), Type.Literal("running"), Type.Literal("queued"), Type.Literal("closing"), Type.Literal("closed")]),
}, objectOptions);
export type Child = Static<typeof ChildSchema>;
export const SnapshotSchema = Type.Object({
  serviceId: Id, epoch: Id, bundleId: Type.String({ pattern: "^[a-f0-9]{64}$" }), revision: Type.Integer({ minimum: 0 }),
  children: Type.Array(ChildSchema), operations: Type.Array(OperationSchema),
}, objectOptions);
export type Snapshot = Static<typeof SnapshotSchema>;
export const ResultRequestSchema = Type.Object({ operationId: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })) }, objectOptions);
export type ResultRequest = Static<typeof ResultRequestSchema>;
export const ResultSchema = Type.Object({
  operationId: Id, status: OperationSchema.properties.status, text: Text, offset: Type.Integer(),
  nextOffset: Type.Union([Type.Integer(), Type.Null()]), total: Type.Integer(), truncated: Type.Boolean(), disposition: Type.String(),
}, objectOptions);
export type ResultPage = Static<typeof ResultSchema>;
export type FullResult = AgentToolResult<SubagentDetails>;
export const FullResultSchema = Type.Unsafe<FullResult | null>(Type.Union([Type.Object({ content: Type.Array(Type.Unknown()), details: Type.Unknown() }, { additionalProperties: true }), Type.Null()]));
export const InspectionSchema = Type.Unsafe<NativeChildSnapshot | null>(Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]));
const ChildRequest = Type.Object({ childId: Id }, objectOptions);
export type Principal = { kind: "owner" };
export const SubagentService = remote("pi-env.subagent.service", {
  version: 2, host: hostNamed("pi-env-subagents"), input: ScopeSchema,
  variants: { owner: { state: { snapshot: SnapshotSchema }, methods: {
    submit: method(SubmitSchema, ReceiptSchema), input: method(InputSchema, ReceiptSchema), cancel: method(CancelSchema),
    result: method(ResultRequestSchema, ResultSchema), resultFull: method(Type.Object({ operationId: Id }, objectOptions), FullResultSchema),
    reopen: method(ChildRequest), closeRun: method(Type.Object({ runId: Id }, objectOptions)),
  } } },
});
export const SubagentInspection = remote("pi-env.subagent.inspection", {
  version: 1, host: hostNamed("pi-env-subagents"), input: Type.Object({ ...ScopeSchema.properties, childId: Id }, objectOptions),
  variants: { owner: { state: { snapshot: InspectionSchema }, methods: { refresh: method(Type.Object({}, objectOptions)) } } },
});
export interface ServiceRuntime {
  snapshot(parentSessionId: string): Snapshot;
  subscribe(parentSessionId: string, listener: (snapshot: Snapshot) => void): () => void;
  submit(parentSessionId: string, input: Submit): Promise<Receipt>;
  input(parentSessionId: string, input: Input): Promise<Receipt>;
  cancel(parentSessionId: string, input: Cancel): Promise<void>;
  result(parentSessionId: string, input: ResultRequest): Promise<ResultPage>;
  resultFull(parentSessionId: string, operationId: string): Promise<FullResult | null>;
  inspect(parentSessionId: string, childId: string): NativeChildSnapshot | null;
  reopen(parentSessionId: string, childId: string): Promise<void>;
  closeRun(runId: string, parentSessionId: string): Promise<void>;
  close(): Promise<void>;
}
