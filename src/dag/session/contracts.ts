import { Data } from "effect";
import type * as DagAttempts from "../attempt.js";
import type * as DagContracts from "../contracts.js";
import type * as DagKernel from "../kernel.js";
import type * as DagValidation from "../validation.js";

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

export type DagAttemptTerminalStatus = DagAttempts.DagAttemptTerminalStatus;
export type DagSessionAttemptStatus = DagAttempts.DagAttemptStatus;
export type DagSessionAttempt = DagAttempts.DagAttempt;

export type DagSessionEvent =
  | { readonly _tag: "graph"; readonly graph: DagContracts.DagDefinition<unknown> }
  | {
      readonly _tag: "transition";
      readonly transition: DagContracts.DagTransition<unknown, unknown>;
      readonly attempt?: DagSessionAttemptStatus;
    }
  | { readonly _tag: "final"; readonly outcome: DagContracts.DagRunOutcome };

export interface DagSessionEntry {
  readonly v: typeof DagSessionWireVersion;
  readonly runId: string;
  readonly graphId: string;
  readonly seq: number;
  readonly event: DagSessionEvent;
}

export interface DagSessionStore {
  readonly read: () => readonly unknown[];
  readonly append: (entry: DagSessionEntry) => void;
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
  readonly operation: "read" | "append";
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
  readonly graph: DagValidation.ValidatedDagDefinition<unknown>;
  readonly graphId: string;
  readonly state: DagKernel.DagRunState<unknown, unknown>;
  readonly terminalOutcome: DagContracts.DagRunOutcome;
  readonly transitions: readonly DagContracts.DagTransition<unknown, unknown>[];
  readonly attempts: readonly DagSessionAttempt[];
  readonly persistedEntryCount: number;
  readonly recoveredFromProcessLoss: boolean;
}
