import {
  DagNodeResultTag,
  DagNodeStatus,
  type DagNodeResult,
  type DagNodeStatus as DagNodeStatusValue,
} from "./contracts.js";

export const DagAttemptOrdinal = 1 as const;

export type DagAttemptTerminalStatus = Exclude<
  DagNodeStatusValue,
  typeof DagNodeStatus.Queued | typeof DagNodeStatus.Blocked | typeof DagNodeStatus.Running
>;
export type DagAttemptStatusValue = typeof DagNodeStatus.Running | DagAttemptTerminalStatus;

export interface DagAttemptStatus {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly ordinal: typeof DagAttemptOrdinal;
  readonly status: DagAttemptStatusValue;
}

export interface DagAttempt {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly ordinal: typeof DagAttemptOrdinal;
  readonly statuses: readonly DagAttemptStatusValue[];
}

export function dagAttemptId(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}:${DagAttemptOrdinal}`;
}

export function dagAttemptStatus(
  runId: string,
  nodeId: string,
  status: DagAttemptStatusValue,
): DagAttemptStatus {
  return {
    nodeId,
    attemptId: dagAttemptId(runId, nodeId),
    ordinal: DagAttemptOrdinal,
    status,
  };
}

export function dagResultStatus(
  result: DagNodeResult<unknown, unknown>,
): DagAttemptTerminalStatus {
  switch (result._tag) {
    case DagNodeResultTag.Succeeded:
      return DagNodeStatus.Succeeded;
    case DagNodeResultTag.Failed:
      return DagNodeStatus.Failed;
    case DagNodeResultTag.Cancelled:
      return DagNodeStatus.Cancelled;
    case DagNodeResultTag.Interrupted:
      return DagNodeStatus.Interrupted;
  }
}

export function isDagAttemptStatus(value: unknown): value is DagAttemptStatusValue {
  return (
    value === DagNodeStatus.Running ||
    value === DagNodeStatus.Succeeded ||
    value === DagNodeStatus.Failed ||
    value === DagNodeStatus.Cancelled ||
    value === DagNodeStatus.Interrupted
  );
}
