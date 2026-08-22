import { createHash } from "node:crypto";
import {
  DagBlockedReason,
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionType,
  type DagCompletionGuardKind,
  type DagDefinition,
  type DagDependencyMode,
  type DagExecutorKind,
  type DagTransition,
} from "../contracts.js";
import {
  DagValidationResultTag,
  validateDagDefinition,
  type ValidatedDagDefinition,
} from "../validation.js";
import {
  DagSessionAttemptInconsistent,
  DagSessionDefaultLimits,
  DagSessionEntryType,
  DagSessionGraphMismatch,
  DagSessionGraphValidation,
  DagSessionLimitExceeded,
  DagSessionMalformed,
  DagSessionRunMismatch,
  DagSessionUnsupportedVersion,
  DagSessionWireVersion,
  type DagSessionAttempt,
  type DagSessionAttemptStatus,
  type DagSessionEntry,
  type DagSessionEvent,
  type DagSessionLimits,
} from "./contracts.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJson(value: unknown): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      break;
    case "object":
      if (Array.isArray(value)) {
        for (const item of value) assertJson(item);
        return;
      }
      for (const item of Object.values(value)) assertJson(item);
      return;
  }
  throw new DagSessionMalformed({ message: "entry contains non-JSON data", entry: value });
}

function canonicalJson(value: unknown): string {
  assertJson(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function computeDagSessionGraphId(graph: DagDefinition<unknown>): string {
  return createHash("sha256").update(canonicalJson(graph)).digest("hex");
}

function requireString(value: unknown, name: string, entry: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new DagSessionMalformed({ message: `malformed ${name}`, entry });
  return value;
}

function requireStringArray(value: unknown, name: string, entry: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))
    throw new DagSessionMalformed({ message: `malformed ${name}`, entry });
  return value;
}

function decodeGraph(raw: unknown, entry: unknown): DagDefinition<unknown> {
  if (!isRecord(raw)) throw new DagSessionMalformed({ message: "malformed graph event", entry });
  const runId = requireString(raw.runId, "graph runId", entry);
  if (typeof raw.concurrency !== "number" || !Number.isSafeInteger(raw.concurrency))
    throw new DagSessionMalformed({ message: "malformed graph concurrency", entry });
  if (!Array.isArray(raw.nodes))
    throw new DagSessionMalformed({ message: "malformed graph nodes", entry });
  return {
    runId,
    concurrency: raw.concurrency,
    nodes: raw.nodes.map((node) => {
      if (!isRecord(node))
        throw new DagSessionMalformed({ message: "malformed graph node", entry });
      const executor = node.executor;
      if (!isRecord(executor))
        throw new DagSessionMalformed({ message: "malformed node executor", entry });
      const dependencies = node.dependencies;
      if (!Array.isArray(dependencies))
        throw new DagSessionMalformed({ message: "malformed node dependencies", entry });
      const completionGuard = node.completionGuard;
      if (completionGuard !== undefined && !isRecord(completionGuard))
        throw new DagSessionMalformed({ message: "malformed completion guard", entry });
      return {
        id: requireString(node.id, "node id", entry),
        executor: {
          kind: requireString(executor.kind, "executor kind", entry) as DagExecutorKind,
          key: requireString(executor.key, "executor key", entry),
          payload: executor.payload,
        },
        dependencies: dependencies.map((dependency) => {
          if (!isRecord(dependency))
            throw new DagSessionMalformed({ message: "malformed dependency", entry });
          return {
            nodeId: requireString(dependency.nodeId, "dependency nodeId", entry),
            mode: requireString(dependency.mode, "dependency mode", entry) as DagDependencyMode,
          };
        }),
        ...(completionGuard
          ? {
              completionGuard: {
                kind: requireString(
                  completionGuard.kind,
                  "completion guard kind",
                  entry,
                ) as DagCompletionGuardKind,
                dependencyIds: requireStringArray(
                  completionGuard.dependencyIds,
                  "completion guard dependencyIds",
                  entry,
                ),
              },
            }
          : {}),
      };
    }),
  };
}

function decodeResult(raw: unknown, entry: unknown) {
  if (!isRecord(raw) || typeof raw._tag !== "string")
    throw new DagSessionMalformed({ message: "malformed result", entry });
  switch (raw._tag) {
    case DagNodeResultTag.Succeeded:
      if (!isRecord(raw.outputs))
        throw new DagSessionMalformed({ message: "malformed succeeded result", entry });
      return { _tag: DagNodeResultTag.Succeeded, outputs: raw.outputs } as const;
    case DagNodeResultTag.Failed:
      if (!("failure" in raw))
        throw new DagSessionMalformed({ message: "malformed failed result", entry });
      return { _tag: DagNodeResultTag.Failed, failure: raw.failure } as const;
    case DagNodeResultTag.Cancelled:
    case DagNodeResultTag.Interrupted:
      if (raw.reason !== undefined && typeof raw.reason !== "string")
        throw new DagSessionMalformed({ message: "malformed terminal reason", entry });
      return raw.reason === undefined
        ? ({ _tag: raw._tag } as const)
        : ({ _tag: raw._tag, reason: raw.reason } as const);
    default:
      throw new DagSessionMalformed({ message: "unknown result variant", entry });
  }
}

export function decodeTransition(
  raw: unknown,
  expectedRunId: string,
  entry: unknown,
): DagTransition<unknown, unknown> {
  if (!isRecord(raw)) throw new DagSessionMalformed({ message: "malformed transition", entry });
  const runId = requireString(raw.runId, "transition runId", entry);
  if (runId !== expectedRunId)
    throw new DagSessionRunMismatch({ expectedRunId, actualRunId: runId });
  const nodeId = requireString(raw.nodeId, "transition nodeId", entry);
  switch (raw.type) {
    case DagTransitionType.Start:
      return { runId, nodeId, type: DagTransitionType.Start };
    case DagTransitionType.Complete:
      return {
        runId,
        nodeId,
        type: DagTransitionType.Complete,
        result: decodeResult(raw.result, entry),
      };
    case DagTransitionType.Block:
      if (
        raw.reason !== DagBlockedReason.RequiredDependency &&
        raw.reason !== DagBlockedReason.CompletionGuard
      )
        throw new DagSessionMalformed({ message: "malformed block reason", entry });
      return {
        runId,
        nodeId,
        type: DagTransitionType.Block,
        reason: raw.reason,
        blockedBy: requireStringArray(raw.blockedBy, "blockedBy", entry),
      };
    case DagTransitionType.Cancel:
      if (raw.reason !== undefined && typeof raw.reason !== "string")
        throw new DagSessionMalformed({ message: "malformed cancel reason", entry });
      return raw.reason === undefined
        ? { runId, nodeId, type: DagTransitionType.Cancel }
        : { runId, nodeId, type: DagTransitionType.Cancel, reason: raw.reason };
    default:
      throw new DagSessionMalformed({ message: "unknown transition variant", entry });
  }
}

export function isAttemptStatus(status: unknown): status is DagSessionAttemptStatus["status"] {
  return (
    status === DagNodeStatus.Running ||
    status === DagNodeStatus.Succeeded ||
    status === DagNodeStatus.Failed ||
    status === DagNodeStatus.Cancelled ||
    status === DagNodeStatus.Interrupted
  );
}

function decodeAttempt(
  raw: unknown,
  expectedRunId: string,
  entry: unknown,
): DagSessionAttemptStatus {
  if (!isRecord(raw)) throw new DagSessionMalformed({ message: "malformed attempt", entry });
  const nodeId = requireString(raw.nodeId, "attempt nodeId", entry);
  const expectedAttemptId = `${expectedRunId}:${nodeId}:1`;
  if (raw.attemptId !== expectedAttemptId || raw.ordinal !== 1)
    throw new DagSessionAttemptInconsistent({
      message: "attempt identity is not deterministic",
      nodeId,
    });
  if (!isAttemptStatus(raw.status))
    throw new DagSessionMalformed({ message: "malformed attempt status", entry });
  return { nodeId, attemptId: expectedAttemptId, ordinal: 1, status: raw.status };
}

export function isDagRunOutcome(raw: unknown): raw is DagRunOutcome {
  return (
    raw === DagRunOutcome.Succeeded ||
    raw === DagRunOutcome.Failed ||
    raw === DagRunOutcome.Cancelled ||
    raw === DagRunOutcome.Interrupted
  );
}

export function decodeOutcome(raw: unknown, entry: unknown): DagRunOutcome {
  if (isDagRunOutcome(raw)) return raw;
  throw new DagSessionMalformed({ message: "malformed final outcome", entry });
}

function decodeEvent(raw: unknown, runId: string, entry: unknown): DagSessionEvent {
  if (!isRecord(raw) || typeof raw._tag !== "string")
    throw new DagSessionMalformed({ message: "malformed event", entry });
  switch (raw._tag) {
    case "graph":
      return { _tag: "graph", graph: decodeGraph(raw.graph, entry) };
    case "transition":
      if (!("transition" in raw))
        throw new DagSessionMalformed({ message: "malformed transition event", entry });
      return raw.attempt !== undefined
        ? {
            _tag: "transition",
            transition: decodeTransition(raw.transition, runId, entry),
            attempt: decodeAttempt(raw.attempt, runId, entry),
          }
        : { _tag: "transition", transition: decodeTransition(raw.transition, runId, entry) };
    case "final":
      return { _tag: "final", outcome: decodeOutcome(raw.outcome, entry) };
    default:
      throw new DagSessionMalformed({ message: "unknown event variant", entry });
  }
}

export function decodeEntry(raw: unknown, limits: DagSessionLimits): DagSessionEntry | undefined {
  if (!isRecord(raw) || raw.type !== "custom" || raw.customType !== DagSessionEntryType)
    return undefined;
  const data = raw.data;
  const size = byteSize(data);
  const sizeLimit =
    isRecord(data) && isRecord(data.event) && data.event._tag === "graph"
      ? limits.graphBytes
      : limits.eventBytes;
  const limitName = sizeLimit === limits.graphBytes ? "graphBytes" : "eventBytes";
  if (size > sizeLimit)
    throw new DagSessionLimitExceeded({ limit: limitName, actual: size, max: sizeLimit });
  if (!isRecord(data))
    throw new DagSessionMalformed({ message: "malformed DAG session entry", entry: raw });
  if (data.v !== DagSessionWireVersion) throw new DagSessionUnsupportedVersion({ version: data.v });
  const runId = requireString(data.runId, "runId", data);
  const graphId = requireString(data.graphId, "graphId", data);
  if (typeof data.seq !== "number" || !Number.isSafeInteger(data.seq) || data.seq < 0)
    throw new DagSessionMalformed({ message: "malformed sequence", entry: data });
  assertJson(data);
  return {
    v: DagSessionWireVersion,
    runId,
    graphId,
    seq: data.seq,
    event: decodeEvent(data.event, runId, data),
  };
}

export function validateLimits(options?: Partial<DagSessionLimits>): DagSessionLimits {
  const limits = { ...DagSessionDefaultLimits, ...options } as DagSessionLimits;
  for (const key of ["graphBytes", "eventBytes", "transitions", "totalMatchingEntries"] as const) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new DagSessionLimitExceeded({
        limit: key,
        actual: value,
        max: Number.MAX_SAFE_INTEGER,
      });
  }
  if (limits.attemptsPerNode !== 1)
    throw new DagSessionLimitExceeded({
      limit: "attemptsPerNode",
      actual: limits.attemptsPerNode,
      max: 1,
    });
  return limits;
}

export function validateGraph(
  graph: DagDefinition<unknown>,
  graphId: string,
  limits: DagSessionLimits,
): ValidatedDagDefinition<unknown> {
  const size = byteSize(graph);
  if (size > limits.graphBytes)
    throw new DagSessionLimitExceeded({
      limit: "graphBytes",
      actual: size,
      max: limits.graphBytes,
    });
  const actualId = computeDagSessionGraphId(graph);
  if (actualId !== graphId)
    throw new DagSessionGraphMismatch({ expectedGraphId: graphId, actualGraphId: actualId });
  const result = validateDagDefinition(graph);
  if (result._tag === DagValidationResultTag.Invalid)
    throw new DagSessionGraphValidation({ errors: result.errors });
  return result.graph;
}

function deriveTransitionAttemptStatus(
  transition: DagTransition<unknown, unknown>,
  wasRunning: boolean,
): DagSessionAttemptStatus["status"] | undefined {
  if (transition.type === DagTransitionType.Start) return DagNodeStatus.Running;
  if (transition.type === DagTransitionType.Cancel)
    return wasRunning ? DagNodeStatus.Cancelled : undefined;
  if (transition.type === DagTransitionType.Complete) return transition.result._tag;
  return undefined;
}

function computeAttemptUpdate(
  prior: DagSessionAttempt | undefined,
  status: DagSessionAttemptStatus,
  expected: DagSessionAttemptStatus["status"],
  runId: string,
): DagSessionAttempt {
  if (
    status.ordinal !== 1 ||
    status.status !== expected ||
    status.attemptId !== `${runId}:${status.nodeId}:1`
  )
    throw new DagSessionAttemptInconsistent({
      message: "attempt status does not match transition",
      nodeId: status.nodeId,
    });
  if (!prior && status.status !== DagNodeStatus.Running)
    throw new DagSessionAttemptInconsistent({
      message: "attempt must start with running",
      nodeId: status.nodeId,
    });
  if (prior && prior.attemptId !== status.attemptId)
    throw new DagSessionAttemptInconsistent({
      message: "multiple attempts are not supported",
      nodeId: status.nodeId,
    });
  if (prior?.statuses.some((seen) => seen !== DagNodeStatus.Running))
    throw new DagSessionAttemptInconsistent({
      message: "attempt already has a terminal status",
      nodeId: status.nodeId,
    });
  if (prior?.statuses.includes(status.status))
    throw new DagSessionAttemptInconsistent({
      message: "attempt status is duplicated",
      nodeId: status.nodeId,
    });
  const next = prior ? [...prior.statuses, status.status] : [status.status];
  if (next.length > 2)
    throw new DagSessionAttemptInconsistent({
      message: "attempt has too many statuses",
      nodeId: status.nodeId,
    });
  return Object.freeze({
    nodeId: status.nodeId,
    attemptId: status.attemptId,
    ordinal: 1,
    statuses: Object.freeze(next),
  });
}

export function computeTransitionAttemptUpdate(
  transition: DagTransition<unknown, unknown>,
  wasRunning: boolean,
  attempt: DagSessionAttemptStatus | undefined,
  prior: DagSessionAttempt | undefined,
  runId: string,
): DagSessionAttempt | undefined {
  const expected = deriveTransitionAttemptStatus(transition, wasRunning);
  if (!expected) {
    if (attempt)
      throw new DagSessionAttemptInconsistent({
        message: "unexpected attempt status",
        nodeId: transition.nodeId,
      });
    return undefined;
  }
  if (!attempt)
    throw new DagSessionAttemptInconsistent({
      message: "missing attempt status",
      nodeId: transition.nodeId,
    });
  if (attempt.nodeId !== transition.nodeId)
    throw new DagSessionAttemptInconsistent({
      message: "attempt node does not match transition",
      nodeId: attempt.nodeId,
    });
  return computeAttemptUpdate(prior, attempt, expected, runId);
}
