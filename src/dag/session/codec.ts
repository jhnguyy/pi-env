import { createHash } from "node:crypto";
import * as DagAttempt from "../attempt.js";
import * as DagContracts from "../contracts.js";
import * as DagValidation from "../validation.js";
import * as SessionContracts from "./contracts.js";

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
  throw new SessionContracts.DagSessionMalformed({ message: "entry contains non-JSON data", entry: value });
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

export function computeDagSessionGraphId(graph: DagContracts.DagDefinition<unknown>): string {
  return createHash("sha256").update(canonicalJson(graph)).digest("hex");
}

function requireString(value: unknown, name: string, entry: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new SessionContracts.DagSessionMalformed({ message: `malformed ${name}`, entry });
  return value;
}

function requireStringArray(value: unknown, name: string, entry: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))
    throw new SessionContracts.DagSessionMalformed({ message: `malformed ${name}`, entry });
  return value;
}

function decodeGraph(raw: unknown, entry: unknown): DagContracts.DagDefinition<unknown> {
  if (!isRecord(raw)) throw new SessionContracts.DagSessionMalformed({ message: "malformed graph event", entry });
  const runId = requireString(raw.runId, "graph runId", entry);
  if (typeof raw.concurrency !== "number" || !Number.isSafeInteger(raw.concurrency))
    throw new SessionContracts.DagSessionMalformed({ message: "malformed graph concurrency", entry });
  if (!Array.isArray(raw.nodes))
    throw new SessionContracts.DagSessionMalformed({ message: "malformed graph nodes", entry });
  return {
    runId,
    concurrency: raw.concurrency,
    nodes: raw.nodes.map((node) => {
      if (!isRecord(node))
        throw new SessionContracts.DagSessionMalformed({ message: "malformed graph node", entry });
      const executor = node.executor;
      if (!isRecord(executor))
        throw new SessionContracts.DagSessionMalformed({ message: "malformed node executor", entry });
      const dependencies = node.dependencies;
      if (!Array.isArray(dependencies))
        throw new SessionContracts.DagSessionMalformed({ message: "malformed node dependencies", entry });
      const completionGuard = node.completionGuard;
      if (completionGuard !== undefined && !isRecord(completionGuard))
        throw new SessionContracts.DagSessionMalformed({ message: "malformed completion guard", entry });
      return {
        id: requireString(node.id, "node id", entry),
        executor: {
          kind: requireString(executor.kind, "executor kind", entry) as DagContracts.DagExecutorKind,
          key: requireString(executor.key, "executor key", entry),
          payload: executor.payload,
        },
        dependencies: dependencies.map((dependency) => {
          if (!isRecord(dependency))
            throw new SessionContracts.DagSessionMalformed({ message: "malformed dependency", entry });
          return {
            nodeId: requireString(dependency.nodeId, "dependency nodeId", entry),
            mode: requireString(dependency.mode, "dependency mode", entry) as DagContracts.DagDependencyMode,
          };
        }),
        ...(completionGuard
          ? {
              completionGuard: {
                kind: requireString(
                  completionGuard.kind,
                  "completion guard kind",
                  entry,
                ) as DagContracts.DagCompletionGuardKind,
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
    throw new SessionContracts.DagSessionMalformed({ message: "malformed result", entry });
  switch (raw._tag) {
    case DagContracts.DagNodeResultTag.Succeeded:
      if (!isRecord(raw.outputs))
        throw new SessionContracts.DagSessionMalformed({ message: "malformed succeeded result", entry });
      return { _tag: DagContracts.DagNodeResultTag.Succeeded, outputs: raw.outputs } as const;
    case DagContracts.DagNodeResultTag.Failed:
      if (!("failure" in raw))
        throw new SessionContracts.DagSessionMalformed({ message: "malformed failed result", entry });
      return { _tag: DagContracts.DagNodeResultTag.Failed, failure: raw.failure } as const;
    case DagContracts.DagNodeResultTag.Cancelled:
    case DagContracts.DagNodeResultTag.Interrupted:
      if (raw.reason !== undefined && typeof raw.reason !== "string")
        throw new SessionContracts.DagSessionMalformed({ message: "malformed terminal reason", entry });
      return raw.reason === undefined
        ? ({ _tag: raw._tag } as const)
        : ({ _tag: raw._tag, reason: raw.reason } as const);
    default:
      throw new SessionContracts.DagSessionMalformed({ message: "unknown result variant", entry });
  }
}

export function decodeTransition(
  raw: unknown,
  expectedRunId: string,
  entry: unknown,
): DagContracts.DagTransition<unknown, unknown> {
  if (!isRecord(raw)) throw new SessionContracts.DagSessionMalformed({ message: "malformed transition", entry });
  const runId = requireString(raw.runId, "transition runId", entry);
  if (runId !== expectedRunId)
    throw new SessionContracts.DagSessionRunMismatch({ expectedRunId, actualRunId: runId });
  const nodeId = requireString(raw.nodeId, "transition nodeId", entry);
  switch (raw.type) {
    case DagContracts.DagTransitionType.Start:
      return { runId, nodeId, type: DagContracts.DagTransitionType.Start };
    case DagContracts.DagTransitionType.Complete:
      return {
        runId,
        nodeId,
        type: DagContracts.DagTransitionType.Complete,
        result: decodeResult(raw.result, entry),
      };
    case DagContracts.DagTransitionType.Block:
      if (
        raw.reason !== DagContracts.DagBlockedReason.RequiredDependency &&
        raw.reason !== DagContracts.DagBlockedReason.CompletionGuard
      )
        throw new SessionContracts.DagSessionMalformed({ message: "malformed block reason", entry });
      return {
        runId,
        nodeId,
        type: DagContracts.DagTransitionType.Block,
        reason: raw.reason,
        blockedBy: requireStringArray(raw.blockedBy, "blockedBy", entry),
      };
    case DagContracts.DagTransitionType.Cancel:
      if (raw.reason !== undefined && typeof raw.reason !== "string")
        throw new SessionContracts.DagSessionMalformed({ message: "malformed cancel reason", entry });
      return raw.reason === undefined
        ? { runId, nodeId, type: DagContracts.DagTransitionType.Cancel }
        : { runId, nodeId, type: DagContracts.DagTransitionType.Cancel, reason: raw.reason };
    default:
      throw new SessionContracts.DagSessionMalformed({ message: "unknown transition variant", entry });
  }
}


function decodeAttempt(
  raw: unknown,
  expectedRunId: string,
  entry: unknown,
): SessionContracts.DagSessionAttemptStatus {
  if (!isRecord(raw)) throw new SessionContracts.DagSessionMalformed({ message: "malformed attempt", entry });
  const nodeId = requireString(raw.nodeId, "attempt nodeId", entry);
  const expectedAttemptId = DagAttempt.dagAttemptId(expectedRunId, nodeId);
  if (
    raw.attemptId !== expectedAttemptId ||
    raw.ordinal !== DagAttempt.DagAttemptOrdinal
  )
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "attempt identity is not deterministic",
      nodeId,
    });
  if (!DagAttempt.isDagAttemptStatus(raw.status))
    throw new SessionContracts.DagSessionMalformed({ message: "malformed attempt status", entry });
  return {
    nodeId,
    attemptId: expectedAttemptId,
    ordinal: DagAttempt.DagAttemptOrdinal,
    status: raw.status,
  };
}

export function isDagRunOutcome(raw: unknown): raw is DagContracts.DagRunOutcome {
  return (
    raw === DagContracts.DagRunOutcome.Succeeded ||
    raw === DagContracts.DagRunOutcome.Failed ||
    raw === DagContracts.DagRunOutcome.Cancelled ||
    raw === DagContracts.DagRunOutcome.Interrupted
  );
}

export function decodeOutcome(raw: unknown, entry: unknown): DagContracts.DagRunOutcome {
  if (isDagRunOutcome(raw)) return raw;
  throw new SessionContracts.DagSessionMalformed({ message: "malformed final outcome", entry });
}

function decodeEvent(raw: unknown, runId: string, entry: unknown): SessionContracts.DagSessionEvent {
  if (!isRecord(raw) || typeof raw._tag !== "string")
    throw new SessionContracts.DagSessionMalformed({ message: "malformed event", entry });
  switch (raw._tag) {
    case "graph":
      return { _tag: "graph", graph: decodeGraph(raw.graph, entry) };
    case "transition":
      if (!("transition" in raw))
        throw new SessionContracts.DagSessionMalformed({ message: "malformed transition event", entry });
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
      throw new SessionContracts.DagSessionMalformed({ message: "unknown event variant", entry });
  }
}

export function decodeEntry(
  data: unknown,
  limits: SessionContracts.DagSessionLimits,
): SessionContracts.DagSessionEntry {
  const size = byteSize(data);
  const sizeLimit =
    isRecord(data) && isRecord(data.event) && data.event._tag === "graph"
      ? limits.graphBytes
      : limits.eventBytes;
  const limitName = sizeLimit === limits.graphBytes ? "graphBytes" : "eventBytes";
  if (size > sizeLimit)
    throw new SessionContracts.DagSessionLimitExceeded({ limit: limitName, actual: size, max: sizeLimit });
  if (!isRecord(data))
    throw new SessionContracts.DagSessionMalformed({
      message: "malformed DAG session entry",
      entry: data,
    });
  if (data.v !== SessionContracts.DagSessionWireVersion) throw new SessionContracts.DagSessionUnsupportedVersion({ version: data.v });
  const runId = requireString(data.runId, "runId", data);
  const graphId = requireString(data.graphId, "graphId", data);
  if (typeof data.seq !== "number" || !Number.isSafeInteger(data.seq) || data.seq < 0)
    throw new SessionContracts.DagSessionMalformed({ message: "malformed sequence", entry: data });
  assertJson(data);
  return {
    v: SessionContracts.DagSessionWireVersion,
    runId,
    graphId,
    seq: data.seq,
    event: decodeEvent(data.event, runId, data),
  };
}

export function validateLimits(options?: Partial<SessionContracts.DagSessionLimits>): SessionContracts.DagSessionLimits {
  const limits = { ...SessionContracts.DagSessionDefaultLimits, ...options } as SessionContracts.DagSessionLimits;
  for (const key of ["graphBytes", "eventBytes", "transitions", "totalMatchingEntries"] as const) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new SessionContracts.DagSessionLimitExceeded({
        limit: key,
        actual: value,
        max: Number.MAX_SAFE_INTEGER,
      });
  }
  if (limits.attemptsPerNode !== 1)
    throw new SessionContracts.DagSessionLimitExceeded({
      limit: "attemptsPerNode",
      actual: limits.attemptsPerNode,
      max: 1,
    });
  return limits;
}

export function validateGraph(
  graph: DagContracts.DagDefinition<unknown>,
  graphId: string,
  limits: SessionContracts.DagSessionLimits,
): DagValidation.ValidatedDagDefinition<unknown> {
  const size = byteSize(graph);
  if (size > limits.graphBytes)
    throw new SessionContracts.DagSessionLimitExceeded({
      limit: "graphBytes",
      actual: size,
      max: limits.graphBytes,
    });
  const actualId = computeDagSessionGraphId(graph);
  if (actualId !== graphId)
    throw new SessionContracts.DagSessionGraphMismatch({ expectedGraphId: graphId, actualGraphId: actualId });
  const result = DagValidation.validateDagDefinition(graph);
  if (result._tag === DagValidation.DagValidationResultTag.Invalid)
    throw new SessionContracts.DagSessionGraphValidation({ errors: result.errors });
  return result.graph;
}

function deriveTransitionAttemptStatus(
  transition: DagContracts.DagTransition<unknown, unknown>,
  wasRunning: boolean,
): SessionContracts.DagSessionAttemptStatus["status"] | undefined {
  if (transition.type === DagContracts.DagTransitionType.Start) return DagContracts.DagNodeStatus.Running;
  if (transition.type === DagContracts.DagTransitionType.Cancel)
    return wasRunning ? DagContracts.DagNodeStatus.Cancelled : undefined;
  if (transition.type === DagContracts.DagTransitionType.Complete)
    return DagAttempt.dagResultStatus(transition.result);
  return undefined;
}

function computeAttemptUpdate(
  prior: SessionContracts.DagSessionAttempt | undefined,
  status: SessionContracts.DagSessionAttemptStatus,
  expected: SessionContracts.DagSessionAttemptStatus["status"],
  runId: string,
): SessionContracts.DagSessionAttempt {
  if (
    status.ordinal !== DagAttempt.DagAttemptOrdinal ||
    status.status !== expected ||
    status.attemptId !== DagAttempt.dagAttemptId(runId, status.nodeId)
  )
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "attempt status does not match transition",
      nodeId: status.nodeId,
    });
  if (!prior && status.status !== DagContracts.DagNodeStatus.Running)
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "attempt must start with running",
      nodeId: status.nodeId,
    });
  if (prior && prior.attemptId !== status.attemptId)
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "multiple attempts are not supported",
      nodeId: status.nodeId,
    });
  if (prior?.statuses.some((seen) => seen !== DagContracts.DagNodeStatus.Running))
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "attempt already has a terminal status",
      nodeId: status.nodeId,
    });
  if (prior?.statuses.includes(status.status))
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "attempt status is duplicated",
      nodeId: status.nodeId,
    });
  const next = prior ? [...prior.statuses, status.status] : [status.status];
  if (next.length > 2)
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "attempt has too many statuses",
      nodeId: status.nodeId,
    });
  return Object.freeze({
    nodeId: status.nodeId,
    attemptId: status.attemptId,
    ordinal: DagAttempt.DagAttemptOrdinal,
    statuses: Object.freeze(next),
  });
}

export function computeTransitionAttemptUpdate(
  transition: DagContracts.DagTransition<unknown, unknown>,
  wasRunning: boolean,
  attempt: SessionContracts.DagSessionAttemptStatus | undefined,
  prior: SessionContracts.DagSessionAttempt | undefined,
  runId: string,
): SessionContracts.DagSessionAttempt | undefined {
  const expected = deriveTransitionAttemptStatus(transition, wasRunning);
  if (!expected) {
    if (attempt)
      throw new SessionContracts.DagSessionAttemptInconsistent({
        message: "unexpected attempt status",
        nodeId: transition.nodeId,
      });
    return undefined;
  }
  if (!attempt)
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "missing attempt status",
      nodeId: transition.nodeId,
    });
  if (attempt.nodeId !== transition.nodeId)
    throw new SessionContracts.DagSessionAttemptInconsistent({
      message: "attempt node does not match transition",
      nodeId: attempt.nodeId,
    });
  return computeAttemptUpdate(prior, attempt, expected, runId);
}
