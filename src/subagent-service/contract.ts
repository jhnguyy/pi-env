import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type, type Static } from "typebox";

const Id = Type.String({ minLength: 1, maxLength: 128 });
const Text = Type.String({ maxLength: 16_384 });
export const SubmitSchema = Type.Object({
  requestId: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  task: Type.String({ minLength: 1, maxLength: 16_384 }),
  cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
  model: Type.Optional(Id),
  tools: Type.Optional(Type.Array(Id, { maxItems: 32 })),
  systemPrompt: Type.Optional(Text),
}, { additionalProperties: false });
export type Submit = Static<typeof SubmitSchema>;
export const InputSchema = Type.Object({
  requestId: Id, childId: Id,
  mode: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
  text: Type.String({ minLength: 1, maxLength: 16_384 }),
}, { additionalProperties: false });
export type Input = Static<typeof InputSchema>;
export const CancelSchema = Type.Object({ requestId: Id, operationId: Id }, { additionalProperties: false });
export type Cancel = Static<typeof CancelSchema>;
export const ReceiptSchema = Type.Object({ childId: Id, operationId: Id }, { additionalProperties: false });
export type Receipt = Static<typeof ReceiptSchema>;
export const OperationSchema = Type.Object({
  ...ReceiptSchema.properties,
  kind: Type.Union([Type.Literal("initial"), Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
  status: Type.Union([Type.Literal("accepted"), Type.Literal("dispatched"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted")]),
  cancelRequested: Type.Boolean(),
  result: Type.Union([Type.Object({ text: Text, truncated: Type.Boolean(), disposition: Type.String({ maxLength: 64 }) }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false });
export type Operation = Static<typeof OperationSchema>;
export const SnapshotSchema = Type.Object({
  serviceId: Id, epoch: Id, revision: Type.Integer({ minimum: 0 }),
  operations: Type.Array(OperationSchema, { maxItems: 128 }),
}, { additionalProperties: false });
export type Snapshot = Static<typeof SnapshotSchema>;
export type Principal = { kind: "owner" };

export const SubagentService = remote("pi-env.subagent.service", {
  version: 1,
  host: hostNamed("pi-env-subagents"),
  input: Type.Object({}, { additionalProperties: false }),
  variants: {
    owner: {
      state: { snapshot: SnapshotSchema },
      methods: {
        submit: method(SubmitSchema, ReceiptSchema),
        input: method(InputSchema, ReceiptSchema),
        cancel: method(CancelSchema),
        inspect: method(Type.Object({ childId: Id }, { additionalProperties: false }), Text),
      },
    },
  },
});

export interface ServiceRuntime {
  snapshot(): Snapshot;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  submit(input: Submit): Promise<Receipt>;
  input(input: Input): Promise<Receipt>;
  cancel(input: Cancel): Promise<void>;
  inspect(childId: string): string;
  close(): Promise<void>;
}
