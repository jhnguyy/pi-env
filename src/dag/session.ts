import { createHash } from "node:crypto";
import { Data, Effect } from "effect";
import {
  DagBlockedReason,
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionType,
  type DagDefinition,
  type DagNodeStatus as DagNodeStatusValue,
  type DagTransition,
} from "./contracts.js";
import {
  DagRunOutcomeResultTag,
  DagTransitionResultTag,
  createDagRunState,
  deriveDagRunOutcome,
  deriveDagSchedulingStep,
  reduceDagRunState,
  type DagRunState,
} from "./kernel.js";
import {
  DagValidationResultTag,
  validateDagDefinition,
  type ValidatedDagDefinition,
} from "./validation.js";

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

export type DagAttemptTerminalStatus = Exclude<
  DagNodeStatusValue,
  typeof DagNodeStatus.Queued | typeof DagNodeStatus.Blocked
>;
export interface DagSessionAttemptStatus {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly ordinal: 1;
  readonly status: typeof DagNodeStatus.Running | DagAttemptTerminalStatus;
}
export interface DagSessionAttempt {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly ordinal: 1;
  readonly statuses: readonly (typeof DagNodeStatus.Running | DagAttemptTerminalStatus)[];
}

export type DagSessionEvent =
  | { readonly _tag: "graph"; readonly graph: DagDefinition<unknown> }
  | {
      readonly _tag: "transition";
      readonly transition: DagTransition<unknown, unknown>;
      readonly attempt?: DagSessionAttemptStatus;
    }
  | { readonly _tag: "final"; readonly outcome: DagRunOutcome };

export interface DagSessionEntry {
  readonly v: typeof DagSessionWireVersion;
  readonly runId: string;
  readonly graphId: string;
  readonly seq: number;
  readonly event: DagSessionEvent;
}

export interface DagSessionManagerSeam {
  readonly getBranch: () => readonly unknown[];
  readonly appendCustomEntry: (customType: string, data?: unknown) => string;
}

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
  | DagSessionFinalInconsistent;

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

function toSessionFailure(error: unknown): DagSessionFailure {
  if (
    error instanceof DagSessionMalformed ||
    error instanceof DagSessionUnsupportedVersion ||
    error instanceof DagSessionLimitExceeded ||
    error instanceof DagSessionRunNotFound ||
    error instanceof DagSessionRunMismatch ||
    error instanceof DagSessionGraphMismatch ||
    error instanceof DagSessionOrdering ||
    error instanceof DagSessionDuplicate ||
    error instanceof DagSessionTruncated ||
    error instanceof DagSessionGraphValidation ||
    error instanceof DagSessionReducerIllegal ||
    error instanceof DagSessionAttemptInconsistent ||
    error instanceof DagSessionFinalInconsistent
  )
    return error;
  return new DagSessionMalformed({
    message: "unexpected DAG session persistence failure",
    entry: error,
  });
}

export interface DagSessionReconstruction {
  readonly graph: ValidatedDagDefinition<unknown>;
  readonly graphId: string;
  readonly state: DagRunState<unknown, unknown>;
  readonly terminalOutcome: DagRunOutcome;
  readonly transitions: readonly DagTransition<unknown, unknown>[];
  readonly attempts: readonly DagSessionAttempt[];
  readonly persistedEntryCount: number;
  readonly recoveredFromProcessLoss: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}
function deepFreeze<T>(value: T): T {
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

function decodeTransition(
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
  if (
    raw.status !== DagNodeStatus.Running &&
    raw.status !== DagNodeStatus.Succeeded &&
    raw.status !== DagNodeStatus.Failed &&
    raw.status !== DagNodeStatus.Cancelled &&
    raw.status !== DagNodeStatus.Interrupted
  )
    throw new DagSessionMalformed({ message: "malformed attempt status", entry });
  return { nodeId, attemptId: expectedAttemptId, ordinal: 1, status: raw.status };
}

function decodeOutcome(raw: unknown, entry: unknown): DagRunOutcome {
  if (
    raw === DagRunOutcome.Succeeded ||
    raw === DagRunOutcome.Failed ||
    raw === DagRunOutcome.Cancelled ||
    raw === DagRunOutcome.Interrupted
  )
    return raw;
  throw new DagSessionMalformed({ message: "malformed final outcome", entry });
}

function decodeEvent(raw: unknown, runId: string, entry: unknown): DagSessionEvent {
  if (!isRecord(raw) || typeof raw._tag !== "string")
    throw new DagSessionMalformed({ message: "malformed event", entry });
  switch (raw._tag) {
    case "graph":
      if (!isRecord(raw.graph))
        throw new DagSessionMalformed({ message: "malformed graph event", entry });
      return { _tag: "graph", graph: raw.graph as unknown as DagDefinition<unknown> };
    case "transition":
      if (!("transition" in raw))
        throw new DagSessionMalformed({ message: "malformed transition event", entry });
      if (raw.attempt !== undefined)
        return {
          _tag: "transition",
          transition: decodeTransition(raw.transition, runId, entry),
          attempt: decodeAttempt(raw.attempt, runId, entry),
        };
      return { _tag: "transition", transition: decodeTransition(raw.transition, runId, entry) };
    case "final":
      return { _tag: "final", outcome: decodeOutcome(raw.outcome, entry) };
    default:
      throw new DagSessionMalformed({ message: "unknown event variant", entry });
  }
}

function decodeEntry(raw: unknown, limits: DagSessionLimits): DagSessionEntry | undefined {
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
    throw new DagSessionLimitExceeded({
      limit: limitName,
      actual: size,
      max: sizeLimit,
    });
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

function validateLimits(options?: Partial<DagSessionLimits>): DagSessionLimits {
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

function validateGraph(
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

function terminalStatus(
  transition: DagTransition<unknown, unknown>,
): DagSessionAttemptStatus["status"] | undefined {
  if (transition.type === DagTransitionType.Start) return DagNodeStatus.Running;
  if (transition.type === DagTransitionType.Cancel) return DagNodeStatus.Cancelled;
  if (transition.type === DagTransitionType.Complete) return transition.result._tag;
  return undefined;
}

function cloneAttempts(map: Map<string, DagSessionAttempt>): Map<string, DagSessionAttempt> {
  return new Map(
    [...map].map(([key, value]) => [key, { ...value, statuses: [...value.statuses] }]),
  );
}

function recordAttempt(
  map: Map<string, DagSessionAttempt>,
  status: DagSessionAttemptStatus,
  expected: DagNodeStatusValue,
  runId: string,
): void {
  if (
    status.ordinal !== 1 ||
    status.status !== expected ||
    status.attemptId !== `${runId}:${status.nodeId}:1`
  )
    throw new DagSessionAttemptInconsistent({
      message: "attempt status does not match transition",
      nodeId: status.nodeId,
    });
  const prior = map.get(status.nodeId);
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
    throw new DagSessionDuplicate({ seq: -1 });
  if (prior?.statuses.includes(status.status)) throw new DagSessionDuplicate({ seq: -1 });
  const next = prior ? [...prior.statuses, status.status] : [status.status];
  if (next.length > 2)
    throw new DagSessionAttemptInconsistent({
      message: "attempt has too many statuses",
      nodeId: status.nodeId,
    });
  map.set(
    status.nodeId,
    Object.freeze({
      nodeId: status.nodeId,
      attemptId: status.attemptId,
      ordinal: 1,
      statuses: Object.freeze(next),
    }),
  );
}

function requireAttemptFor(
  transition: DagTransition<unknown, unknown>,
  wasRunning: boolean,
  attempt: DagSessionAttemptStatus | undefined,
  attempts: Map<string, DagSessionAttempt>,
  runId: string,
): void {
  const expected =
    transition.type === DagTransitionType.Cancel && !wasRunning
      ? undefined
      : terminalStatus(transition);
  if (!expected) {
    if (attempt)
      throw new DagSessionAttemptInconsistent({
        message: "unexpected attempt status",
        nodeId: transition.nodeId,
      });
    return;
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
  recordAttempt(attempts, attempt, expected, runId);
}

function applyTransition(
  graph: ValidatedDagDefinition<unknown>,
  state: DagRunState<unknown, unknown>,
  transition: DagTransition<unknown, unknown>,
) {
  if (transition.runId !== graph.runId)
    throw new DagSessionRunMismatch({ expectedRunId: graph.runId, actualRunId: transition.runId });
  const result = reduceDagRunState(graph, state, transition);
  if (result._tag === DagTransitionResultTag.Rejected)
    throw new DagSessionReducerIllegal({ transition, error: result.error });
  return result;
}

function ensureTransitionCapacity(transitions: readonly unknown[], limits: DagSessionLimits): void {
  if (transitions.length >= limits.transitions)
    throw new DagSessionLimitExceeded({
      limit: "transitions",
      actual: transitions.length + 1,
      max: limits.transitions,
    });
}

function projectProcessLoss(
  graph: ValidatedDagDefinition<unknown>,
  state0: DagRunState<unknown, unknown>,
  transitions: DagTransition<unknown, unknown>[],
  attempts: Map<string, DagSessionAttempt>,
  limits: DagSessionLimits,
): DagRunState<unknown, unknown> {
  let state = state0;
  for (const node of state.nodes)
    if (node.status === DagNodeStatus.Running) {
      ensureTransitionCapacity(transitions, limits);
      const t = {
        runId: graph.runId,
        nodeId: node.nodeId,
        type: DagTransitionType.Complete,
        result: { _tag: DagNodeResultTag.Interrupted, reason: DagSessionProcessLossReason },
      } as const;
      const applied = applyTransition(graph, state, t);
      state = applied.state;
      transitions.push(applied.transition);
      recordAttempt(
        attempts,
        {
          nodeId: node.nodeId,
          attemptId: `${graph.runId}:${node.nodeId}:1`,
          ordinal: 1,
          status: DagNodeStatus.Interrupted,
        },
        DagNodeStatus.Interrupted,
        graph.runId,
      );
    }
  for (;;) {
    const step = deriveDagSchedulingStep(graph, state);
    if (step.transitions.length === 0) break;
    for (const transition of step.transitions) ensureTransitionCapacity(transitions, limits);
    state = step.state;
    transitions.push(...step.transitions);
  }
  for (const node of state.nodes)
    if (node.status === DagNodeStatus.Queued) {
      ensureTransitionCapacity(transitions, limits);
      const t = {
        runId: graph.runId,
        nodeId: node.nodeId,
        type: DagTransitionType.Cancel,
        reason: DagSessionProcessLossReason,
      } as const;
      const applied = applyTransition(graph, state, t);
      state = applied.state;
      transitions.push(applied.transition);
    }
  return state;
}

function selectRequestedEntries(
  decoded: readonly DagSessionEntry[],
  requestedRunId: string,
  options: { readonly expectedGraphId?: string } | undefined,
): readonly DagSessionEntry[] {
  const entries = decoded.filter((entry) => entry.runId === requestedRunId);
  if (entries.length === 0) throw new DagSessionRunNotFound({ runId: requestedRunId });
  if (
    options?.expectedGraphId &&
    entries.some((entry) => entry.graphId !== options.expectedGraphId)
  )
    throw new DagSessionGraphMismatch({
      expectedGraphId: options.expectedGraphId,
      actualGraphId:
        entries.find((entry) => entry.graphId !== options.expectedGraphId)?.graphId ?? "",
    });
  const graphIds = new Set(entries.map((entry) => entry.graphId));
  if (graphIds.size !== 1)
    throw new DagSessionGraphMismatch({
      expectedGraphId: entries[0]?.graphId ?? "",
      actualGraphId: entries.find((entry) => entry.graphId !== entries[0]?.graphId)?.graphId ?? "",
    });
  return entries;
}

function validateEntryOrder(entries: readonly DagSessionEntry[]): void {
  for (let i = 1; i < entries.length; i++)
    if (entries[i]!.seq <= entries[i - 1]!.seq)
      throw entries[i]!.seq === entries[i - 1]!.seq
        ? new DagSessionDuplicate({ seq: entries[i]!.seq })
        : new DagSessionOrdering({ message: "sequence decreased", seq: entries[i]!.seq });
  entries.forEach((entry, index) => {
    if (entry.seq !== index)
      throw new DagSessionTruncated({ expectedSeq: index, actualSeq: entry.seq });
  });
}

type DagSessionGraphEntry = DagSessionEntry & {
  readonly event: Extract<DagSessionEvent, { readonly _tag: "graph" }>;
};

function selectGraphEntry(entries: readonly DagSessionEntry[]): DagSessionGraphEntry {
  const graphEntries = entries.filter((entry) => entry.event._tag === "graph");
  if (graphEntries.length !== 1 || graphEntries[0]?.seq !== 0)
    throw new DagSessionOrdering({ message: "sequence 0 must be exactly one graph entry" });
  const graphEntry = graphEntries[0];
  if (!graphEntry || graphEntry.event._tag !== "graph")
    throw new DagSessionMalformed({ message: "missing graph event" });
  return graphEntry as DagSessionGraphEntry;
}

function replaySession(
  graph: ValidatedDagDefinition<unknown>,
  entries: readonly DagSessionEntry[],
  limits: DagSessionLimits,
): {
  state: DagRunState<unknown, unknown>;
  transitions: DagTransition<unknown, unknown>[];
  attempts: Map<string, DagSessionAttempt>;
  final: DagRunOutcome | undefined;
} {
  let state: DagRunState<unknown, unknown> = createDagRunState(graph);
  const transitions: DagTransition<unknown, unknown>[] = [];
  const attempts = new Map<string, DagSessionAttempt>();
  let final: DagRunOutcome | undefined;
  for (const entry of entries.slice(1)) {
    if (final) throw new DagSessionOrdering({ message: "final must be last", seq: entry.seq });
    const event = entry.event;
    if (event._tag === "final") {
      final = event.outcome;
      continue;
    }
    if (event._tag !== "transition")
      throw new DagSessionMalformed({ message: "unknown event variant", entry });
    ensureTransitionCapacity(transitions, limits);
    const wasRunning = state.nodes.some(
      (node) => node.nodeId === event.transition.nodeId && node.status === DagNodeStatus.Running,
    );
    const applied = applyTransition(graph, state, event.transition);
    requireAttemptFor(applied.transition, wasRunning, event.attempt, attempts, graph.runId);
    state = applied.state;
    transitions.push(applied.transition);
  }
  return { state, transitions, attempts, final };
}

function finalizeReplayedSession(
  graph: ValidatedDagDefinition<unknown>,
  replayed: {
    state: DagRunState<unknown, unknown>;
    transitions: DagTransition<unknown, unknown>[];
    attempts: Map<string, DagSessionAttempt>;
    final: DagRunOutcome | undefined;
  },
  limits: DagSessionLimits,
): {
  state: DagRunState<unknown, unknown>;
  transitions: DagTransition<unknown, unknown>[];
  attempts: Map<string, DagSessionAttempt>;
  outcome: DagRunOutcome;
  recoveredFromProcessLoss: boolean;
} {
  let { state, transitions, attempts, final } = replayed;
  let recoveredFromProcessLoss = false;
  if (!final) {
    recoveredFromProcessLoss = true;
    state = projectProcessLoss(graph, state, transitions, attempts, limits);
  }
  const outcome = deriveDagRunOutcome(graph, state);
  if (outcome._tag !== DagRunOutcomeResultTag.Terminal)
    throw new DagSessionFinalInconsistent({ message: "history is not terminal" });
  if (final && final !== outcome.outcome)
    throw new DagSessionFinalInconsistent({ message: "final outcome does not match state" });
  return { state, transitions, attempts, outcome: outcome.outcome, recoveredFromProcessLoss };
}

export function reconstructDagSession(
  seam: DagSessionManagerSeam,
  requestedRunId: string,
  options?: { readonly expectedGraphId?: string; readonly limits?: Partial<DagSessionLimits> },
): Effect.Effect<DagSessionReconstruction, DagSessionFailure> {
  return Effect.try({
    try: () => {
      const limits = validateLimits(options?.limits);
      const matchingEntries = seam
        .getBranch()
        .filter(
          (entry) =>
            isRecord(entry) && entry.type === "custom" && entry.customType === DagSessionEntryType,
        );
      if (matchingEntries.length > limits.totalMatchingEntries)
        throw new DagSessionLimitExceeded({
          limit: "totalMatchingEntries",
          actual: matchingEntries.length,
          max: limits.totalMatchingEntries,
        });
      const decoded = matchingEntries
        .map((entry) => decodeEntry(entry, limits))
        .filter((entry): entry is DagSessionEntry => entry !== undefined);
      const entries = selectRequestedEntries(decoded, requestedRunId, options);
      validateEntryOrder(entries);
      const graphEntry = selectGraphEntry(entries);
      const graph = validateGraph(graphEntry.event.graph, graphEntry.graphId, limits);
      if (graph.runId !== requestedRunId)
        throw new DagSessionRunMismatch({
          expectedRunId: requestedRunId,
          actualRunId: graph.runId,
        });
      const replayed = replaySession(graph, entries, limits);
      const finalized = finalizeReplayedSession(graph, replayed, limits);
      return deepFreeze({
        graph,
        graphId: graphEntry.graphId,
        state: finalized.state,
        terminalOutcome: finalized.outcome,
        transitions: Object.freeze(finalized.transitions),
        attempts: Object.freeze([...finalized.attempts.values()]),
        persistedEntryCount: entries.length,
        recoveredFromProcessLoss: finalized.recoveredFromProcessLoss,
      });
    },
    catch: toSessionFailure,
  });
}

export interface DagSessionWriter {
  readonly appendGraph: (
    graph: DagDefinition<unknown>,
  ) => Effect.Effect<DagSessionEntry, DagSessionFailure>;
  readonly appendTransition: (
    transition: DagTransition<unknown, unknown>,
    attempt?: DagSessionAttemptStatus,
  ) => Effect.Effect<DagSessionEntry, DagSessionFailure>;
  readonly appendFinal: (
    outcome: DagRunOutcome,
  ) => Effect.Effect<DagSessionEntry, DagSessionFailure>;
}

export function makeDagSessionWriter(
  seam: DagSessionManagerSeam,
  graph: ValidatedDagDefinition<unknown>,
  graphDefinition: DagDefinition<unknown>,
  options?: { readonly limits?: Partial<DagSessionLimits> },
): DagSessionWriter {
  const limits = validateLimits(options?.limits);
  const graphId = computeDagSessionGraphId(graphDefinition);
  const validatedGraphId = computeDagSessionGraphId(graph);
  let seq = 0;
  let state: DagRunState<unknown, unknown> = createDagRunState(graph);
  let final = false;
  const attempts = new Map<string, DagSessionAttempt>();
  const append = (entry: DagSessionEntry) => {
    if (entry.seq >= limits.totalMatchingEntries)
      throw new DagSessionLimitExceeded({
        limit: "totalMatchingEntries",
        actual: entry.seq + 1,
        max: limits.totalMatchingEntries,
      });
    const frozen = deepFreeze(entry);
    const size = byteSize(frozen);
    const sizeLimit = entry.event._tag === "graph" ? limits.graphBytes : limits.eventBytes;
    const limitName = entry.event._tag === "graph" ? "graphBytes" : "eventBytes";
    if (size > sizeLimit)
      throw new DagSessionLimitExceeded({
        limit: limitName,
        actual: size,
        max: sizeLimit,
      });
    seam.appendCustomEntry(DagSessionEntryType, frozen);
    return frozen;
  };
  return {
    appendGraph: (definition) =>
      Effect.try({
        try: () => {
          if (seq !== 0)
            throw new DagSessionOrdering({ message: "graph must be appended exactly once" });
          validateGraph(definition, graphId, limits);
          if (validatedGraphId !== graphId)
            throw new DagSessionGraphMismatch({
              expectedGraphId: graphId,
              actualGraphId: validatedGraphId,
            });
          const entry = {
            v: DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: { _tag: "graph", graph: definition },
          } satisfies DagSessionEntry;
          const persisted = append(entry);
          seq += 1;
          return persisted;
        },
        catch: toSessionFailure,
      }),
    appendTransition: (transition, attempt) =>
      Effect.try({
        try: () => {
          if (final) throw new DagSessionOrdering({ message: "cannot append after final" });
          if (seq === 0) throw new DagSessionOrdering({ message: "graph must be appended first" });
          if (transition.runId !== graph.runId)
            throw new DagSessionRunMismatch({
              expectedRunId: graph.runId,
              actualRunId: transition.runId,
            });
          if (seq - 1 >= limits.transitions)
            throw new DagSessionLimitExceeded({
              limit: "transitions",
              actual: seq,
              max: limits.transitions,
            });
          const candidateAttempts = cloneAttempts(attempts);
          const wasRunning = state.nodes.some(
            (node) => node.nodeId === transition.nodeId && node.status === DagNodeStatus.Running,
          );
          const applied = applyTransition(graph, state, transition);
          requireAttemptFor(
            applied.transition,
            wasRunning,
            attempt,
            candidateAttempts,
            graph.runId,
          );
          const entry = {
            v: DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: {
              _tag: "transition",
              transition: applied.transition,
              ...(attempt ? { attempt } : {}),
            },
          } satisfies DagSessionEntry;
          const persisted = append(entry);
          state = applied.state;
          attempts.clear();
          for (const item of candidateAttempts) attempts.set(item[0], item[1]);
          seq += 1;
          return persisted;
        },
        catch: toSessionFailure,
      }),
    appendFinal: (outcome) =>
      Effect.try({
        try: () => {
          if (final) throw new DagSessionOrdering({ message: "cannot append after final" });
          if (seq === 0) throw new DagSessionOrdering({ message: "graph must be appended first" });
          decodeOutcome(outcome, outcome);
          const derived = deriveDagRunOutcome(graph, state);
          if (derived._tag !== DagRunOutcomeResultTag.Terminal || derived.outcome !== outcome)
            throw new DagSessionFinalInconsistent({
              message: "final outcome does not match state",
            });
          const entry = {
            v: DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: { _tag: "final", outcome },
          } satisfies DagSessionEntry;
          const persisted = append(entry);
          final = true;
          seq += 1;
          return persisted;
        },
        catch: toSessionFailure,
      }),
  };
}
