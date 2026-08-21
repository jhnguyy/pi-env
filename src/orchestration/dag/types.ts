import type { DagRunState } from "./state.js";

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

export const DagValidationResultTag = {
  Valid: "valid",
  Invalid: "invalid",
} as const;
export type DagValidationResultTag =
  (typeof DagValidationResultTag)[keyof typeof DagValidationResultTag];

export const DagValidationErrorTag = {
  InvalidLimits: "invalid-limits",
  InvalidDefinition: "invalid-definition",
  EmptyGraph: "empty-graph",
  NodeLimitExceeded: "node-limit-exceeded",
  EdgeLimitExceeded: "edge-limit-exceeded",
  ConcurrencyLimitExceeded: "concurrency-limit-exceeded",
  InvalidRunId: "invalid-run-id",
  InvalidNodeId: "invalid-node-id",
  DuplicateNode: "duplicate-node",
  InvalidExecutor: "invalid-executor",
  UnsupportedExecutorKind: "unsupported-executor-kind",
  MissingDependency: "missing-dependency",
  SelfDependency: "self-dependency",
  DuplicateDependency: "duplicate-dependency",
  UnsupportedDependencyMode: "unsupported-dependency-mode",
  InvalidCompletionGuard: "invalid-completion-guard",
  Cycle: "cycle",
} as const;
export type DagValidationErrorTag =
  (typeof DagValidationErrorTag)[keyof typeof DagValidationErrorTag];

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

export const DagTransitionResultTag = {
  Applied: "applied",
  Rejected: "rejected",
} as const;
export type DagTransitionResultTag =
  (typeof DagTransitionResultTag)[keyof typeof DagTransitionResultTag];

export const DagTransitionErrorTag = {
  RunMismatch: "run-mismatch",
  UnknownNode: "unknown-node",
  InvalidState: "invalid-state",
  MalformedTransition: "malformed-transition",
  InvalidTransition: "invalid-transition",
  InvalidBlock: "invalid-block",
} as const;
export type DagTransitionErrorTag =
  (typeof DagTransitionErrorTag)[keyof typeof DagTransitionErrorTag];

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

export const DagRunOutcomeResultTag = {
  NonTerminal: "non-terminal",
  Terminal: "terminal",
} as const;
export type DagRunOutcomeResultTag =
  (typeof DagRunOutcomeResultTag)[keyof typeof DagRunOutcomeResultTag];

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

export interface ValidatedDagDefinition<TPayload = unknown> extends DagDefinition<TPayload> {
  readonly _tag: "ValidatedDagDefinition";
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

export type DagValidationError =
  | { readonly _tag: typeof DagValidationErrorTag.InvalidLimits }
  | { readonly _tag: typeof DagValidationErrorTag.InvalidDefinition }
  | { readonly _tag: typeof DagValidationErrorTag.EmptyGraph }
  | {
      readonly _tag: typeof DagValidationErrorTag.NodeLimitExceeded;
      readonly limit: number;
      readonly actual: number;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.EdgeLimitExceeded;
      readonly limit: number;
      readonly actual: number;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.ConcurrencyLimitExceeded;
      readonly limit: number;
      readonly actual: number;
    }
  | { readonly _tag: typeof DagValidationErrorTag.InvalidRunId }
  | {
      readonly _tag: typeof DagValidationErrorTag.InvalidNodeId;
      readonly nodeIndex: number;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.DuplicateNode;
      readonly nodeId: string;
      readonly firstIndex: number;
      readonly duplicateIndex: number;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.InvalidExecutor;
      readonly nodeId: string;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.UnsupportedExecutorKind;
      readonly nodeId: string;
      readonly kind: unknown;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.MissingDependency;
      readonly nodeId: string;
      readonly dependencyId: string;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.SelfDependency;
      readonly nodeId: string;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.DuplicateDependency;
      readonly nodeId: string;
      readonly dependencyId: string;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.UnsupportedDependencyMode;
      readonly nodeId: string;
      readonly dependencyId: string;
      readonly mode: unknown;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.InvalidCompletionGuard;
      readonly nodeId: string;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.Cycle;
      readonly nodeIds: readonly string[];
    };

export type DagValidationResult<TPayload = unknown> =
  | {
      readonly _tag: typeof DagValidationResultTag.Valid;
      readonly graph: ValidatedDagDefinition<TPayload>;
    }
  | {
      readonly _tag: typeof DagValidationResultTag.Invalid;
      readonly errors: readonly DagValidationError[];
    };

export interface DagOutputReference<TLocator = unknown> {
  readonly kind: string;
  readonly locator: TLocator;
}

export type DagNamedOutputs<TReference extends DagOutputReference = DagOutputReference> = Readonly<
  Record<string, TReference>
>;

export interface DagFailure {
  readonly code: string;
  readonly message: string;
}

export type DagNodeResult<TReference extends DagOutputReference = DagOutputReference> =
  | {
      readonly _tag: typeof DagNodeResultTag.Succeeded;
      readonly outputs: DagNamedOutputs<TReference>;
      readonly summary?: string;
    }
  | {
      readonly _tag: typeof DagNodeResultTag.Failed;
      readonly failure: DagFailure;
    }
  | {
      readonly _tag: typeof DagNodeResultTag.Cancelled;
      readonly reason?: string;
    }
  | {
      readonly _tag: typeof DagNodeResultTag.Interrupted;
      readonly reason?: string;
    };

interface DagNodeStateBase {
  readonly nodeId: string;
  readonly status: DagNodeStatus;
}

export type DagNodeState<TReference extends DagOutputReference = DagOutputReference> =
  | (DagNodeStateBase & { readonly status: typeof DagNodeStatus.Queued })
  | (DagNodeStateBase & { readonly status: typeof DagNodeStatus.Running })
  | (DagNodeStateBase & {
      readonly status: typeof DagNodeStatus.Succeeded;
      readonly outputs: DagNamedOutputs<TReference>;
      readonly summary?: string;
    })
  | (DagNodeStateBase & {
      readonly status: typeof DagNodeStatus.Failed;
      readonly failure: DagFailure;
    })
  | (DagNodeStateBase & {
      readonly status: typeof DagNodeStatus.Blocked;
      readonly blockedBy: readonly string[];
      readonly reason: DagBlockedReason;
    })
  | (DagNodeStateBase & {
      readonly status: typeof DagNodeStatus.Cancelled;
      readonly reason?: string;
    })
  | (DagNodeStateBase & {
      readonly status: typeof DagNodeStatus.Interrupted;
      readonly reason?: string;
    });

interface DagTransitionBase {
  readonly runId: string;
  readonly nodeId: string;
}

export type DagTransition<TReference extends DagOutputReference = DagOutputReference> =
  | (DagTransitionBase & { readonly type: typeof DagTransitionType.Start })
  | (DagTransitionBase & {
      readonly type: typeof DagTransitionType.Complete;
      readonly result: DagNodeResult<TReference>;
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

export type DagTransitionError =
  | {
      readonly _tag: typeof DagTransitionErrorTag.RunMismatch;
      readonly expectedRunId: string;
      readonly actualRunId: string;
    }
  | {
      readonly _tag: typeof DagTransitionErrorTag.UnknownNode;
      readonly nodeId: string;
    }
  | { readonly _tag: typeof DagTransitionErrorTag.InvalidState }
  | {
      readonly _tag: typeof DagTransitionErrorTag.MalformedTransition;
      readonly nodeId?: string;
    }
  | {
      readonly _tag: typeof DagTransitionErrorTag.InvalidTransition;
      readonly nodeId: string;
      readonly from: DagNodeStatus;
      readonly to: DagNodeStatus;
    }
  | {
      readonly _tag: typeof DagTransitionErrorTag.InvalidBlock;
      readonly nodeId: string;
      readonly blockedBy: readonly string[];
      readonly reason: DagBlockedReason;
    };

export type DagTransitionResult<TReference extends DagOutputReference = DagOutputReference> =
  | {
      readonly _tag: typeof DagTransitionResultTag.Applied;
      readonly state: DagRunState<TReference>;
      readonly transition: DagTransition<TReference>;
    }
  | {
      readonly _tag: typeof DagTransitionResultTag.Rejected;
      readonly error: DagTransitionError;
    };

export interface DagSchedulingStep<TReference extends DagOutputReference = DagOutputReference> {
  readonly state: DagRunState<TReference>;
  readonly transitions: readonly DagTransition<TReference>[];
  readonly readyNodeIds: readonly string[];
}

export type DagRunOutcomeResult =
  | {
      readonly _tag: typeof DagRunOutcomeResultTag.NonTerminal;
      readonly nodeIds: readonly string[];
    }
  | {
      readonly _tag: typeof DagRunOutcomeResultTag.Terminal;
      readonly outcome: DagRunOutcome;
    };
