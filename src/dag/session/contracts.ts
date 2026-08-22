import { Data } from "effect";
import {
  type DagDefinition,
  type DagNodeStatus as DagNodeStatusValue,
  DagNodeStatus,
  type DagRunOutcome,
  type DagTransition,
} from "../contracts.js";
import { type DagRunState } from "../kernel.js";
import { type ValidatedDagDefinition } from "../validation.js";

export const DagSessionEntryType = "pi/dag-run-event" as const;
export const DagSessionWireVersion = 1 as const;
export const DagSessionProcessLossReason = "process loss before run finalized" as const;

export interface DagSessionLimits {
  readonly graphBytes: number;
  readonly eventBytes: number;
  readonly transitions: number;
  readonly attemptsPerNode: 1;
  readonly totalMatchingEntries: number;
}

export const DagSessionDefaultLimits = Object.freeze({
  graphBytes: 262_144,
  eventBytes: 65_536,
  transitions: 8_192,
  attemptsPerNode: 1,
  totalMatchingEntries: 16_384,
} as const satisfies DagSessionLimits);

export type DagAttemptTerminalStatus = Exclude<
  DagNodeStatusValue,
  typeof DagNodeStatus.Queued | typeof DagNodeStatus.Blocked
>;
export interface DagSessionAttemptStatus {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly ordinal: 1;
  readonly status: typeof DagNodeStatus.Running | DagAttemptTerminalStatus;
}
export interface DagSessionAttempt {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly ordinal: 1;
  readonly statuses: readonly (typeof DagNodeStatus.Running | DagAttemptTerminalStatus)[];
}

export type DagSessionEvent =
  | { readonly _tag: "graph"; readonly graph: DagDefinition<unknown> }
  | {
      readonly _tag: "transition";
      readonly transition: DagTransition<unknown, unknown>;
      readonly attempt?: DagSessionAttemptStatus;
    }
  | { readonly _tag: "final"; readonly outcome: DagRunOutcome };

export interface DagSessionEntry {
  readonly v: typeof DagSessionWireVersion;
  readonly runId: string;
  readonly graphId: string;
  readonly seq: number;
  readonly event: DagSessionEvent;
}

export interface DagSessionManagerSeam {
  readonly getBranch: () => readonly unknown[];
  readonly appendCustomEntry: (customType: string, data?: unknown) => string;
}

export class DagSessionMalformed extends Data.TaggedError("malformed")<{
  readonly message: string;
  readonly entry?: unknown;
}> {}
export class DagSessionUnsupportedVersion extends Data.TaggedError("unsupported-version")<{
  readonly version: unknown;
}> {}
export class DagSessionLimitExceeded extends Data.TaggedError("limit")<{
  readonly limit: keyof DagSessionLimits;
  readonly actual: number;
  readonly max: number;
}> {}
export class DagSessionRunNotFound extends Data.TaggedError("run-not-found")<{
  readonly runId: string;
}> {}
export class DagSessionRunMismatch extends Data.TaggedError("run-mismatch")<{
  readonly expectedRunId: string;
  readonly actualRunId: string;
}> {}
export class DagSessionGraphMismatch extends Data.TaggedError("graph-mismatch")<{
  readonly expectedGraphId: string;
  readonly actualGraphId: string;
}> {}
export class DagSessionOrdering extends Data.TaggedError("ordering")<{
  readonly message: string;
  readonly seq?: number;
}> {}
export class DagSessionDuplicate extends Data.TaggedError("duplicate")<{ readonly seq: number }> {}
export class DagSessionTruncated extends Data.TaggedError("truncated")<{
  readonly expectedSeq: number;
  readonly actualSeq: number;
}> {}
export class DagSessionGraphValidation extends Data.TaggedError("graph-validation")<{
  readonly errors: unknown;
}> {}
export class DagSessionReducerIllegal extends Data.TaggedError("reducer-illegal")<{
  readonly transition: unknown;
  readonly error: unknown;
}> {}
export class DagSessionAttemptInconsistent extends Data.TaggedError("attempt-inconsistent")<{
  readonly message: string;
  readonly nodeId?: string;
}> {}
export class DagSessionFinalInconsistent extends Data.TaggedError("final-inconsistent")<{
  readonly message: string;
}> {}
export class DagSessionSeamFailed extends Data.TaggedError("seam-failed")<{
  readonly operation: "getBranch" | "appendCustomEntry";
  readonly cause: unknown;
}> {}

export type DagSessionFailure =
  | DagSessionMalformed
  | DagSessionUnsupportedVersion
  | DagSessionLimitExceeded
  | DagSessionRunNotFound
  | DagSessionRunMismatch
  | DagSessionGraphMismatch
  | DagSessionOrdering
  | DagSessionDuplicate
  | DagSessionTruncated
  | DagSessionGraphValidation
  | DagSessionReducerIllegal
  | DagSessionAttemptInconsistent
  | DagSessionFinalInconsistent
  | DagSessionSeamFailed;

const dagSessionFailureClasses = [
  DagSessionMalformed,
  DagSessionUnsupportedVersion,
  DagSessionLimitExceeded,
  DagSessionRunNotFound,
  DagSessionRunMismatch,
  DagSessionGraphMismatch,
  DagSessionOrdering,
  DagSessionDuplicate,
  DagSessionTruncated,
  DagSessionGraphValidation,
  DagSessionReducerIllegal,
  DagSessionAttemptInconsistent,
  DagSessionFinalInconsistent,
  DagSessionSeamFailed,
] as const;

function isDagSessionFailure(error: unknown): error is DagSessionFailure {
  return dagSessionFailureClasses.some((FailureClass) => error instanceof FailureClass);
}

export function toSessionFailure(error: unknown): DagSessionFailure {
  if (isDagSessionFailure(error)) return error;
  return new DagSessionMalformed({
    message: "unexpected DAG session persistence failure",
    entry: error,
  });
}

export interface DagSessionReconstruction {
  readonly graph: ValidatedDagDefinition<unknown>;
  readonly graphId: string;
  readonly state: DagRunState<unknown, unknown>;
  readonly terminalOutcome: DagRunOutcome;
  readonly transitions: readonly DagTransition<unknown, unknown>[];
  readonly attempts: readonly DagSessionAttempt[];
  readonly persistedEntryCount: number;
  readonly recoveredFromProcessLoss: boolean;
}
