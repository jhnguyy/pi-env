import { hostNamed, method, remote } from "@earendil-works/chord";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  obj,
  str,
  num,
  int,
  bool,
  arr,
  oneOf,
  opt,
  nullable,
  compile,
  type Static,
  type Schema,
} from "@earendil-works/pi-schema";
import type { NativeChildSnapshot } from "../../.pi/extensions/subagent/child-types.js";
import type { SubagentDetails } from "../../.pi/extensions/subagent/types.js";
const UsageSchema = obj({
  input: num(),
  output: num(),
  cacheRead: num(),
  cacheWrite: num(),
  cost: num(),
  turns: num(),
});
export type InitialMetadata = Omit<
  SubagentDetails,
  "task" | "finalOutput" | "usage" | "modelOverride"
> & { modelOverride?: string; usage: Static<typeof UsageSchema> };

const Id = str({ minLength: 1, maxLength: 256 });
const Text = str({ maxLength: 16_384 });
const Prompt = str({ minLength: 1, maxLength: 4 * 1024 * 1024 });
export const MaxServiceRequestBytes = 32 * 1024 * 1024;
const scopeProperties = { parentSessionId: Id };
export const ScopeSchema = obj(scopeProperties);
export const SubmitSchema = obj({
  requestId: Id,
  runId: Id,
  name: str({ minLength: 1, maxLength: 128 }),
  task: Prompt,
  cwd: str({ minLength: 1, maxLength: 4_096 }),
  model: opt(Id),
  tools: opt(arr(Id, { maxItems: 128 })),
  systemPrompt: opt(str({ maxLength: 4 * 1024 * 1024 })),
  reasoning: opt(oneOf(["max", "minimal", "low", "medium", "high", "xhigh"])),
  maxTurns: opt(int({ minimum: 1, maximum: 100_000 })),
  workspaceAccess: opt(oneOf(["read", "write"])),
});
export type Submit = Static<typeof SubmitSchema>;
export const InputSchema = obj({
  requestId: Id,
  childId: Id,
  mode: oneOf(["prompt", "steer", "followUp"]),
  source: oneOf(["coordinator", "human"]),
  text: str({ minLength: 1, maxLength: 16_384 }),
});
export type Input = Static<typeof InputSchema>;
export const CancelSchema = obj({ requestId: Id, operationId: Id });
export type Cancel = Static<typeof CancelSchema>;
const receiptProperties = { childId: Id, operationId: Id };
export const ReceiptSchema = obj(receiptProperties);
export type Receipt = Static<typeof ReceiptSchema>;
const OperationStatusSchema = oneOf([
  "accepted",
  "dispatched",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export const OperationSchema = obj({
  ...receiptProperties,
  parentSessionId: Id,
  runId: Id,
  createdAt: str(),
  kind: oneOf(["initial", "prompt", "steer", "followUp"]),
  status: OperationStatusSchema,
  cancelRequested: bool(),
});
export type Operation = Static<typeof OperationSchema>;
// Native metadata, results and inspections remain opaque at this boundary.
// These schemas preserve the existing envelope checks; they do not validate the
// full native objects, which remain the native owner's responsibility.
const InitialMetadataSchema: Schema<InitialMetadata> = {
  type: "object",
  additionalProperties: true,
};
export const ChildSchema = obj({
  childId: Id,
  parentSessionId: Id,
  runId: Id,
  name: str(),
  task: str(),
  cwd: str(),
  createdAt: str(),
  sessionFile: nullable(str()),
  model: opt(str()),
  initialDetails: opt(InitialMetadataSchema),
  usage: opt(UsageSchema),
  state: oneOf(["historical", "idle", "running", "queued", "closing", "closed"]),
});
export type Child = Static<typeof ChildSchema>;
export const SnapshotSchema = obj({
  serviceId: Id,
  epoch: Id,
  bundleId: str({ pattern: "^[a-f0-9]{64}$" }),
  revision: int({ minimum: 0 }),
  children: arr(ChildSchema),
  operations: arr(OperationSchema),
});
export type Snapshot = Static<typeof SnapshotSchema>;
export const ResultRequestSchema = obj({
  operationId: Id,
  offset: opt(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  limit: opt(int({ minimum: 1, maximum: 16_384 })),
});
export type ResultRequest = Static<typeof ResultRequestSchema>;
export const ResultSchema = obj({
  operationId: Id,
  status: OperationStatusSchema,
  text: Text,
  offset: int(),
  nextOffset: nullable(int()),
  total: int(),
  truncated: bool(),
  disposition: str(),
});
export type ResultPage = Static<typeof ResultSchema>;
export type FullResult = AgentToolResult<SubagentDetails>;
export const FullResultSchema: Schema<FullResult | null> = {
  anyOf: [
    {
      type: "object",
      properties: { content: { type: "array", items: {} }, details: {} },
      required: ["content", "details"],
      additionalProperties: true,
    },
    { type: "null" },
  ],
};
export const InspectionSchema: Schema<NativeChildSnapshot | null> = {
  anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }],
};
const ChildRequest = obj({ childId: Id });
export const ServiceChecks = {
  scope: compile(ScopeSchema).check,
  submit: compile(SubmitSchema).check,
  input: compile(InputSchema).check,
  cancel: compile(CancelSchema).check,
  result: compile(ResultRequestSchema).check,
};
export type Principal = { kind: "owner" };
export const SubagentService = remote("pi-env.subagent.service", {
  version: 2,
  host: hostNamed("pi-env-subagents"),
  input: ScopeSchema,
  variants: {
    owner: {
      state: { snapshot: SnapshotSchema },
      methods: {
        submit: method(SubmitSchema, ReceiptSchema),
        input: method(InputSchema, ReceiptSchema),
        cancel: method(CancelSchema),
        result: method(ResultRequestSchema, ResultSchema),
        resultFull: method(obj({ operationId: Id }), FullResultSchema),
        reopen: method(ChildRequest),
        closeRun: method(obj({ runId: Id })),
      },
    },
  },
});
export const SubagentInspection = remote("pi-env.subagent.inspection", {
  version: 1,
  host: hostNamed("pi-env-subagents"),
  input: obj({ ...scopeProperties, childId: Id }),
  variants: {
    owner: { state: { snapshot: InspectionSchema }, methods: { refresh: method(obj({})) } },
  },
});
export interface ServiceRuntime {
  readonly failure: AbortSignal;
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
