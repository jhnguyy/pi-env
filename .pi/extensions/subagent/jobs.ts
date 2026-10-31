/** Read models for durable service operations. No execution or mutable job lifecycle lives here. */
import type { Child, Operation } from "../../../src/subagent-service/contract";
import type { SubagentJobStatus, SubagentDetails } from "./types";
import { formatUsageCompact } from "./usage";
export { SubagentJobStatus } from "./types";

export interface SubagentJob {
  readonly id: string;
  readonly childId: string;
  readonly name: string;
  readonly task: string;
  readonly cwd: string;
  readonly status: SubagentJobStatus;
  readonly latestDetails?: SubagentDetails;
  readonly sessionFile?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
}

export function jobStatus(operation: Operation): SubagentJobStatus {
  if (operation.status === "accepted") return operation.cancelRequested ? "cancelling" : "queued";
  if (operation.status === "dispatched") return operation.cancelRequested ? "cancelling" : "running";
  return operation.status;
}

export function projectJob(operation: Operation, child: Child): SubagentJob {
  const initial = operation.kind === "initial" ? child.initialDetails : undefined;
  return {
    id: operation.operationId, childId: child.childId, name: child.name, task: child.task,
    cwd: child.cwd, status: jobStatus(operation), createdAt: operation.createdAt,
    sessionFile: child.sessionFile ?? undefined, errorMessage: initial?.errorMessage,
    latestDetails: initial && { ...initial, modelOverride: initial.modelOverride, task: child.task, finalOutput: "" },
  };
}

export function formatJobMetadata(job: SubagentJob): string {
  const details = job.latestDetails;
  const session = job.sessionFile ? ` session:${job.sessionFile}` : "";
  const usage = details?.usage ? ` usage:${formatUsageCompact(details.usage)}` : "";
  const error = job.errorMessage ? ` error:${job.errorMessage}` : "";
  return `[${job.status}] ${job.id} ${job.name} child:${job.childId}${session}${usage}${error}`;
}
