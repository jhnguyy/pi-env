import type { Effect, Scope } from "effect";
import { Context, Data, Layer } from "effect";
import type * as DagContracts from "./contracts.js";
import type * as DagKernel from "./kernel.js";
import type * as DagValidation from "./validation.js";

export class DagRuntimeGraphStateMismatch extends Data.TaggedError("DagRuntimeGraphStateMismatch")<{
  readonly message: string;
  readonly runId: string;
}> {}

export class DagRuntimeNonFreshInitialState extends Data.TaggedError(
  "DagRuntimeNonFreshInitialState",
)<{
  readonly message: string;
  readonly runId: string;
}> {}

export class DagRuntimeCoordinatorFatal extends Data.TaggedError("DagRuntimeCoordinatorFatal")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class DagRuntimeNotAccepting extends Data.TaggedError("DagRuntimeNotAccepting")<{
  readonly message: string;
}> {}

export class DagRuntimeJournalFailed extends Data.TaggedError("DagRuntimeJournalFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class DagExecutorMissing extends Data.TaggedError("DagExecutorMissing")<{
  readonly message: string;
  readonly kind: DagContracts.DagExecutorKind;
  readonly key: string;
}> {}

export class DagExecutorFailed extends Data.TaggedError("DagExecutorFailed")<{
  readonly message: string;
  readonly error: unknown;
}> {}

export class DagExecutorDefected extends Data.TaggedError("DagExecutorDefected")<{
  readonly message: string;
  readonly defect: unknown;
}> {}

export class DagRuntimeReducerFatal extends Data.TaggedError("DagRuntimeReducerFatal")<{
  readonly message: string;
  readonly error: DagKernel.DagTransitionError;
}> {}

export type DagRuntimeError =
  | DagRuntimeGraphStateMismatch
  | DagRuntimeNonFreshInitialState
  | DagRuntimeNotAccepting
  | DagRuntimeReducerFatal
  | DagRuntimeJournalFailed
  | DagRuntimeCoordinatorFatal;
export type DagFailedNodePayload = DagExecutorMissing | DagExecutorFailed | DagExecutorDefected;

export interface DagExecutorRequest {
  readonly runId: string;
  readonly node: DagContracts.DagNode<unknown>;
  readonly attemptId: string;
  readonly attemptOrdinal: 1;
  readonly graphState: DagKernel.DagRunState<unknown, DagFailedNodePayload>;
}

export type DagEffectExecutor = (
  request: DagExecutorRequest,
) => Effect.Effect<DagContracts.DagNamedOutputs<unknown>, unknown, Scope.Scope>;

export interface DagExecutorRegistryService {
  readonly lookup: (
    kind: DagContracts.DagExecutorKind,
    key: string,
  ) => Effect.Effect<DagEffectExecutor | undefined>;
}

export class DagExecutorRegistry extends Context.Service<
  DagExecutorRegistry,
  DagExecutorRegistryService
>()("pi/dag/DagExecutorRegistry") {}

export const DagExecutorRegistryLayer = (
  service: DagExecutorRegistryService,
): Layer.Layer<DagExecutorRegistry> => Layer.succeed(DagExecutorRegistry, service);

export interface DagNodeAttempt {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly ordinal: 1;
  readonly statuses: readonly (
    | typeof DagContracts.DagNodeStatus.Running
    | Exclude<
        (typeof DagContracts.DagNodeStatus)[keyof typeof DagContracts.DagNodeStatus],
        typeof DagContracts.DagNodeStatus.Queued | typeof DagContracts.DagNodeStatus.Blocked
      >
  )[];
}

export interface DagRunSnapshot {
  readonly state: DagKernel.DagRunState<unknown, DagFailedNodePayload>;
  readonly outcome: DagKernel.DagRunOutcomeResult;
  readonly transitions: readonly DagContracts.DagTransition<unknown, DagFailedNodePayload>[];
  readonly attempts: readonly DagNodeAttempt[];
}

export interface DagRuntimeJournalAttemptStatus {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly ordinal: 1;
  readonly status:
    | typeof DagContracts.DagNodeStatus.Running
    | Exclude<
        (typeof DagContracts.DagNodeStatus)[keyof typeof DagContracts.DagNodeStatus],
        typeof DagContracts.DagNodeStatus.Queued | typeof DagContracts.DagNodeStatus.Blocked
      >;
}

export interface DagRuntimeJournal {
  readonly beforeRun: (
    graph: DagValidation.ValidatedDagDefinition<unknown>,
  ) => Effect.Effect<void, unknown>;
  readonly appendTransition: (
    transition: DagContracts.DagTransition<unknown, DagFailedNodePayload>,
    attempt?: DagRuntimeJournalAttemptStatus,
  ) => Effect.Effect<void, unknown>;
  readonly appendFinal: (outcome: DagContracts.DagRunOutcome) => Effect.Effect<void, unknown>;
}

export interface DagRuntimeSubmitOptions {
  readonly journal?: DagRuntimeJournal;
}

export type DagRunAwaitError =
  | DagRuntimeReducerFatal
  | DagRuntimeJournalFailed
  | DagRuntimeCoordinatorFatal;

export interface DagRunHandle {
  readonly snapshot: Effect.Effect<DagRunSnapshot>;
  readonly cancel: Effect.Effect<DagRunSnapshot, DagRunAwaitError>;
  readonly await: Effect.Effect<DagRunSnapshot, DagRunAwaitError>;
}

export interface DagRuntimeServiceShape {
  readonly submit: <TPayload>(
    graph: DagValidation.ValidatedDagDefinition<TPayload>,
    initialState?: DagKernel.DagRunState<unknown, DagFailedNodePayload>,
    options?: DagRuntimeSubmitOptions,
  ) => Effect.Effect<DagRunHandle, DagRuntimeError, DagExecutorRegistry | Scope.Scope>;
}

export class DagRuntimeService extends Context.Service<DagRuntimeService, DagRuntimeServiceShape>()(
  "pi/dag/DagRuntimeService",
) {}
