import * as DagContracts from "./contracts.js";

export const DagAttemptOrdinal = 1 as const;

export type DagAttemptTerminalStatus = Exclude<
  DagContracts.DagNodeStatus,
  | typeof DagContracts.DagNodeStatus.Queued
  | typeof DagContracts.DagNodeStatus.Blocked
  | typeof DagContracts.DagNodeStatus.Running
>;
export type DagAttemptStatusValue =
  | typeof DagContracts.DagNodeStatus.Running
  | DagAttemptTerminalStatus;

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
  result: DagContracts.DagNodeResult<unknown, unknown>,
): DagAttemptTerminalStatus {
  switch (result._tag) {
    case DagContracts.DagNodeResultTag.Succeeded:
      return DagContracts.DagNodeStatus.Succeeded;
    case DagContracts.DagNodeResultTag.Failed:
      return DagContracts.DagNodeStatus.Failed;
    case DagContracts.DagNodeResultTag.Cancelled:
      return DagContracts.DagNodeStatus.Cancelled;
    case DagContracts.DagNodeResultTag.Interrupted:
      return DagContracts.DagNodeStatus.Interrupted;
  }
}

export function isDagAttemptStatus(value: unknown): value is DagAttemptStatusValue {
  return (
    value === DagContracts.DagNodeStatus.Running ||
    value === DagContracts.DagNodeStatus.Succeeded ||
    value === DagContracts.DagNodeStatus.Failed ||
    value === DagContracts.DagNodeStatus.Cancelled ||
    value === DagContracts.DagNodeStatus.Interrupted
  );
}
