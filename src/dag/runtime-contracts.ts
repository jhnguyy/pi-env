import { Context, Data, Effect, Layer, Scope } from "effect";
import {
  DagNodeStatus,
  type DagExecutorKind,
  type DagNamedOutputs,
  type DagNode,
  type DagTransition,
} from "./contracts.js";
import type { DagRunOutcomeResult, DagTransitionError } from "./kernel.js";
import type { DagRunState } from "./kernel.js";
import type { ValidatedDagDefinition } from "./validation.js";

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

export class DagExecutorMissing extends Data.TaggedError("DagExecutorMissing")<{
  readonly message: string;
  readonly kind: DagExecutorKind;
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
  readonly error: DagTransitionError;
}> {}

export type DagRuntimeError =
  | DagRuntimeGraphStateMismatch
  | DagRuntimeNonFreshInitialState
  | DagRuntimeReducerFatal
  | DagRuntimeCoordinatorFatal;
export type DagFailedNodePayload = DagExecutorMissing | DagExecutorFailed | DagExecutorDefected;

export interface DagExecutorRequest {
  readonly runId: string;
  readonly node: DagNode<unknown>;
  readonly attemptId: string;
  readonly attemptOrdinal: 1;
  readonly graphState: DagRunState<unknown, DagFailedNodePayload>;
}

export type DagEffectExecutor = (
  request: DagExecutorRequest,
) => Effect.Effect<DagNamedOutputs<unknown>, unknown, Scope.Scope>;

export interface DagExecutorRegistryService {
  readonly lookup: (
    kind: DagExecutorKind,
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
    | typeof DagNodeStatus.Running
    | Exclude<
        (typeof DagNodeStatus)[keyof typeof DagNodeStatus],
        typeof DagNodeStatus.Queued | typeof DagNodeStatus.Blocked
      >
  )[];
}

export interface DagRunSnapshot {
  readonly state: DagRunState<unknown, DagFailedNodePayload>;
  readonly outcome: DagRunOutcomeResult;
  readonly transitions: readonly DagTransition<unknown, DagFailedNodePayload>[];
  readonly attempts: readonly DagNodeAttempt[];
}

export interface DagRunHandle {
  readonly snapshot: Effect.Effect<DagRunSnapshot>;
  readonly cancel: Effect.Effect<
    DagRunSnapshot,
    DagRuntimeReducerFatal | DagRuntimeCoordinatorFatal
  >;
  readonly await: Effect.Effect<
    DagRunSnapshot,
    DagRuntimeReducerFatal | DagRuntimeCoordinatorFatal
  >;
}

export interface DagRuntimeServiceShape {
  readonly submit: <TPayload>(
    graph: ValidatedDagDefinition<TPayload>,
    initialState?: DagRunState<unknown, DagFailedNodePayload>,
  ) => Effect.Effect<DagRunHandle, DagRuntimeError, DagExecutorRegistry | Scope.Scope>;
}

export class DagRuntimeService extends Context.Service<DagRuntimeService, DagRuntimeServiceShape>()(
  "pi/dag/DagRuntimeService",
) {}
