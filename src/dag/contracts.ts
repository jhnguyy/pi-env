export const DagNodeStatus = {
  Queued: "queued",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  Blocked: "blocked",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
} as const;
export type DagNodeStatus = (typeof DagNodeStatus)[keyof typeof DagNodeStatus];

export const DagDependencyMode = {
  Required: "required",
  Settled: "settled",
} as const;
export type DagDependencyMode = (typeof DagDependencyMode)[keyof typeof DagDependencyMode];

export const DagExecutorKind = {
  Subagent: "subagent",
  Transform: "transform",
  Materialize: "materialize",
} as const;
export type DagExecutorKind = (typeof DagExecutorKind)[keyof typeof DagExecutorKind];

export const DagCompletionGuardKind = {
  AtLeastOneSucceeded: "at-least-one-succeeded",
} as const;
export type DagCompletionGuardKind =
  (typeof DagCompletionGuardKind)[keyof typeof DagCompletionGuardKind];

export const DagNodeResultTag = {
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
} as const;
export type DagNodeResultTag = (typeof DagNodeResultTag)[keyof typeof DagNodeResultTag];

export const DagTransitionType = {
  Start: "start",
  Complete: "complete",
  Block: "block",
  Cancel: "cancel",
} as const;
export type DagTransitionType = (typeof DagTransitionType)[keyof typeof DagTransitionType];

export const DagBlockedReason = {
  RequiredDependency: "required-dependency",
  CompletionGuard: "completion-guard",
} as const;
export type DagBlockedReason = (typeof DagBlockedReason)[keyof typeof DagBlockedReason];

export const DagRunOutcome = {
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
} as const;
export type DagRunOutcome = (typeof DagRunOutcome)[keyof typeof DagRunOutcome];

export interface DagExecutor<TPayload = unknown> {
  readonly kind: DagExecutorKind;
  readonly key: string;
  readonly payload: TPayload;
}

export interface DagDependency {
  readonly nodeId: string;
  readonly mode: DagDependencyMode;
}

export interface DagCompletionGuard {
  readonly kind: DagCompletionGuardKind;
  readonly dependencyIds: readonly string[];
}

export interface DagNode<TPayload = unknown> {
  readonly id: string;
  readonly executor: DagExecutor<TPayload>;
  readonly dependencies: readonly DagDependency[];
  readonly completionGuard?: DagCompletionGuard;
}

export interface DagDefinition<TPayload = unknown> {
  readonly runId: string;
  readonly concurrency: number;
  readonly nodes: readonly DagNode<TPayload>[];
}

export interface DagValidationLimits {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxConcurrency: number;
}

export const DagDefaultValidationLimits = {
  maxNodes: 256,
  maxEdges: 2_048,
  maxConcurrency: 32,
} as const satisfies DagValidationLimits;

export type DagNamedOutputs<TOutputReference = unknown> = Readonly<
  Record<string, TOutputReference>
>;

export type DagNodeResult<TOutputReference = unknown, TFailure = unknown> =
  | {
      readonly _tag: typeof DagNodeResultTag.Succeeded;
      readonly outputs: DagNamedOutputs<TOutputReference>;
    }
  | {
      readonly _tag: typeof DagNodeResultTag.Failed;
      readonly failure: TFailure;
    }
  | {
      readonly _tag: typeof DagNodeResultTag.Cancelled;
      readonly reason?: string;
    }
  | {
      readonly _tag: typeof DagNodeResultTag.Interrupted;
      readonly reason?: string;
    };

export type DagNodeState<TOutputReference = unknown, TFailure = unknown> =
  | { readonly nodeId: string; readonly status: typeof DagNodeStatus.Queued }
  | { readonly nodeId: string; readonly status: typeof DagNodeStatus.Running }
  | {
      readonly nodeId: string;
      readonly status: typeof DagNodeStatus.Succeeded;
      readonly outputs: DagNamedOutputs<TOutputReference>;
    }
  | {
      readonly nodeId: string;
      readonly status: typeof DagNodeStatus.Failed;
      readonly failure: TFailure;
    }
  | {
      readonly nodeId: string;
      readonly status: typeof DagNodeStatus.Blocked;
      readonly reason: DagBlockedReason;
      readonly blockedBy: readonly string[];
    }
  | {
      readonly nodeId: string;
      readonly status: typeof DagNodeStatus.Cancelled;
      readonly reason?: string;
    }
  | {
      readonly nodeId: string;
      readonly status: typeof DagNodeStatus.Interrupted;
      readonly reason?: string;
    };

interface DagTransitionBase {
  readonly runId: string;
  readonly nodeId: string;
}

export type DagTransition<TOutputReference = unknown, TFailure = unknown> =
  | (DagTransitionBase & { readonly type: typeof DagTransitionType.Start })
  | (DagTransitionBase & {
      readonly type: typeof DagTransitionType.Complete;
      readonly result: DagNodeResult<TOutputReference, TFailure>;
    })
  | (DagTransitionBase & {
      readonly type: typeof DagTransitionType.Block;
      readonly reason: DagBlockedReason;
      readonly blockedBy: readonly string[];
    })
  | (DagTransitionBase & {
      readonly type: typeof DagTransitionType.Cancel;
      readonly reason?: string;
    });
