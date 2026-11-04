import { createHash, randomUUID } from "node:crypto";
import { inspectionPage } from "./inspection.js";
import { pageText } from "./pagination.js";
import { lstat, mkdir, realpath, statfs, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { ProjectTrustStore, SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Harness,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { withChildContext } from "../../.pi/extensions/_shared/child-context.js";
import { loadSubagentRuntimeConfig } from "../../.pi/extensions/subagent/config.js";
import { SubagentRunSupervisor } from "../../.pi/extensions/subagent/control.js";
import { NativeChildOwner } from "../../.pi/extensions/subagent/native-child.js";
import { NativeInputMode } from "../../.pi/extensions/subagent/child-types.js";
import { addUsage, getFinalOutput, zeroUsage } from "../../.pi/extensions/subagent/usage.js";
import type { NativeChildSnapshot } from "../../.pi/extensions/subagent/child-types.js";
import {
  MaxServiceRequestBytes,
  ServiceChecks,
  type FullResult,
  type Child,
  type Input,
  type Operation,
  type Receipt,
  type ServiceRuntime,
  type Snapshot,
  type Submit,
  type Reopen,
} from "./contract.js";

type StoredResult = {
  text: string;
  preview: { text: string; truncated: boolean };
  disposition: string;
  originalJson: string | null;
};

type StoredOperation = Operation & {
  requestId: string;
  fingerprint: string;
  spec: Submit | null;
  input: Input | null;
  result: StoredResult | null;
  inspectionJson: string | null;
  inspectionRevision: number | null;
  taskId: TaskId<null> | null;
};
type Store = {
  serviceId: string;
  bundleId: string;
  agentDir: string;
  revision: number;
  operations: StoredOperation[];
  children: Child[];
  closedRuns: { runId: string; parentSessionId: string }[];
  cancellations: { requestId: string; operationId: string; parentSessionId: string }[];
};
const StoreDoc = defineDoc<{ store: Store | null }>({
  kind: "pi-env.subagent.service",
  version: 3,
  scope: "session",
  initial: () => ({ store: null }),
  checkpointWhen: () => true,
});
const terminal = (op: Operation) => op.status !== "accepted" && op.status !== "dispatched";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function bounded(text: string, limit = 4_096): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  return {
    text:
      bytes.length > limit
        ? bytes
            .subarray(0, limit - 4)
            .toString("utf8")
            .replace(/\uFFFD$/, "") + "…"
        : text,
    truncated: bytes.length > limit,
  };
}
function required(store: Store | null | undefined): Store {
  if (!store) throw new Error("invalid_store");
  return store;
}
function operation(store: Store, id: string): StoredOperation {
  const found = store.operations.find((op) => op.operationId === id);
  if (!found) throw new Error("operation_not_found");
  return found;
}

// Restrict the first slice to private Linux-local SQLite storage; do not silently accept network WAL.
async function privateDirectory(directory: string): Promise<{ directory: string }> {
  if (process.platform !== "linux") throw new Error("unsupported_platform");
  if (!isAbsolute(directory) || Buffer.byteLength(join(directory, "service.sock")) > 103)
    throw new Error("absolute_short_state_directory_required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const fs = await statfs(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("private_state_directory_required");
  if (![0xef53, 0x58465342, 0x9123683e, 0x794c7630, 0x2fc12fc1, 0x01021994].includes(fs.type))
    throw new Error("local_state_filesystem_required");
  return { directory: await realpath(directory) };
}

type ServiceOptions = {
  directory: string;
  bundleId: string;
  agentDir?: string;
  maxRetainedOperations?: number;
  maxOutstandingOperations?: number;
  openStorage?: typeof openNodeSqliteStorage;
};

function serviceCapacity(options: ServiceOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.bundleId)) throw new Error("executable_digest_required");
  const maxRetained = options.maxRetainedOperations ?? 256;
  const maxOutstanding = options.maxOutstandingOperations ?? 20;
  if (![maxRetained, maxOutstanding].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 512))
    throw new Error("invalid_capacity");
  return { maxRetained, maxOutstanding };
}

function executionFailure(record: StoredOperation, error: unknown): StoredResult {
  const text =
    error instanceof Error
      ? error.message
      : "Native execution failed; inspect the retained child when available.";
  const spec = record.spec;
  const original: FullResult | null = spec
    ? {
        content: [{ type: "text", text }],
        details: {
          name: spec.name,
          task: spec.task,
          cwd: spec.cwd,
          modelOverride: spec.model,
          toolNames: spec.tools ?? [],
          finalOutput: "",
          toolCallCount: 0,
          usage: zeroUsage(),
          stopReason: "startup",
          errorMessage: text,
          isError: true,
          turnLimitExceeded: false,
        },
      }
    : null;
  return {
    text,
    preview: bounded(text),
    originalJson: original && JSON.stringify(original),
    disposition: "failed",
  };
}

async function ensureServiceIdentity(directory: string, bundleId: string, agentDir: string) {
  const identityFile = join(directory, "identity.json");
  const expectedIdentity = JSON.stringify({ version: 3, bundleId, agentDir });
  const identity = await lstat(identityFile).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (identity) {
    if (
      !identity.isFile() ||
      identity.nlink !== 1 ||
      identity.uid !== process.getuid?.() ||
      (identity.mode & 0o7777) !== 0o600
    )
      throw new Error("unsafe_service_identity");
    if ((await readFile(identityFile, "utf8")) !== expectedIdentity)
      throw new Error(
        "incompatible_service_bundle: retain existing state; no automatic migration is available",
      );
  } else {
    const database = await lstat(join(directory, "service.sqlite")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (database)
      throw new Error("incompatible_service_state: existing database has no matching identity");
    await writeFile(identityFile, expectedIdentity, { flag: "wx", mode: 0o600 });
  }
}

function initialMetadata(details: FullResult["details"], sessionFile: Child["sessionFile"]) {
  const { task: _task, finalOutput: _output, ...metadata } = details;
  return {
    ...metadata,
    name: metadata.name.slice(0, 128),
    toolNames: metadata.toolNames.slice(0, 32).map((name) => name.slice(0, 128)),
    ...(metadata.errorMessage !== undefined
      ? { errorMessage: metadata.errorMessage.slice(0, 1024) }
      : {}),
    sessionFile: sessionFile ?? metadata.sessionFile,
  };
}

/** Promise compatibility boundary for native Pi, Chord and Durable. The service owns every execution signal. */
export async function openServiceRuntime(options: ServiceOptions): Promise<ServiceRuntime> {
  const { maxRetained, maxOutstanding } = serviceCapacity(options);
  const local = await privateDirectory(options.directory);
  const agentDir = await realpath(options.agentDir ?? getAgentDir());
  const limits = loadSubagentRuntimeConfig(local.directory, agentDir);
  const release = await processLock(`pi-env.subagents:${process.getuid?.()}:${agentDir}`);
  const epoch = randomUUID();
  const supervisor = new SubagentRunSupervisor(`service:${epoch}`, limits);
  const nativeIds = new Map<string, string>();
  const usageOffsets = new Map<string, NonNullable<Child["usage"]>>();
  const ownerFor = (childId: string) => supervisor.children.get(nativeIds.get(childId) ?? "");
  const active = new Map<string, string>();
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<{ parentSessionId: string; listener: (snapshot: Snapshot) => void }>();
  const reopening = new Map<string, Promise<void>>();
  const historicalInspections = new Map<string, NativeChildSnapshot>();
  const inspectionVersions = new Map<string, string>();
  const closingRuns = new Set<string>();
  const runKey = (parent: string, run: string) => JSON.stringify([parent, run]);
  let harness: Harness | undefined;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let closing = false;
  const failure = new AbortController();
  let closeRuntime: (() => Promise<void>) | undefined;
  const fail = (cause: unknown) => {
    if (closing || failure.signal.aborted) return;
    console.error("Subagent service failed; disconnecting observers without replay.", cause);
    failure.abort(
      new Error("Subagent durable Harness failed; operation outcomes may be unknown.", { cause }),
    );
    void closeRuntime?.().catch((error: unknown) =>
      console.error("Subagent failure cleanup failed", error),
    );
  };
  let summaryObserver: ReturnType<typeof setInterval> | undefined;
  let observingSummary = false;
  let publishedNativeStates = new Map<string, Child["state"]>();
  let closePromise: Promise<void> | undefined;
  let current: Snapshot = {
    serviceId: "opening",
    epoch,
    bundleId: options.bundleId,
    revision: 0,
    children: [],
    operations: [],
  };
  const summarizeChild = (child: Child): Child => ({
    ...child,
    task: child.task.slice(0, 256),
    model: ownerFor(child.childId)?.summary().model ?? child.model,
    state:
      child.state === "closed"
        ? "closed"
        : (ownerFor(child.childId)?.summary().state ?? "historical"),
  });
  const scoped = (parentSessionId: string): Snapshot =>
    JSON.parse(
      JSON.stringify({
        ...current,
        children: current.children
          .filter((child) => child.parentSessionId === parentSessionId)
          .map(summarizeChild),
        operations: current.operations.filter((op) => op.parentSessionId === parentSessionId),
      }),
    ) as Snapshot;
  const findChild = (parentSessionId: string, childId: string) => {
    const child = current.children.find(
      (child) => child.childId === childId && child.parentSessionId === parentSessionId,
    );
    if (!child) throw new Error("child_not_found");
    return child;
  };
  const scopedOperation = (store: Store, parentSessionId: string, id: string) => {
    const op = operation(store, id);
    if (op.parentSessionId !== parentSessionId) throw new Error("operation_not_found");
    return op;
  };
  const closedRun = (store: Store, parent: string, run: string) =>
    closingRuns.has(runKey(parent, run)) ||
    store.closedRuns.some((item) => item.parentSessionId === parent && item.runId === run);
  const publish = async () => {
    const store = required((await harness!.snapshot(StoreDoc, context))?.store);
    const latestInspections = new Map<string, StoredOperation>();
    for (const op of store.operations) {
      if (
        op.inspectionJson &&
        op.inspectionJson !== "null" &&
        (op.inspectionRevision ?? 0) >=
          (latestInspections.get(op.childId)?.inspectionRevision ?? -1)
      )
        latestInspections.set(op.childId, op);
    }
    for (const [childId, op] of latestInspections) {
      if (inspectionVersions.get(childId) === op.inspectionJson) continue;
      historicalInspections.set(childId, JSON.parse(op.inspectionJson!) as NativeChildSnapshot);
      inspectionVersions.set(childId, op.inspectionJson!);
    }
    const next: Snapshot = {
      serviceId: store.serviceId,
      epoch,
      bundleId: store.bundleId,
      revision: store.revision,
      children: store.children.map(summarizeChild),
      operations: store.operations.map(
        ({
          childId,
          operationId,
          parentSessionId,
          runId,
          createdAt,
          kind,
          status,
          cancelRequested,
        }) => ({
          childId,
          operationId,
          parentSessionId,
          runId,
          createdAt,
          kind,
          status,
          cancelRequested,
        }),
      ),
    };
    if (next.revision < current.revision) return;
    current = next;
    publishedNativeStates = new Map(
      [...supervisor.children].map(([id, owner]) => [id, owner.summary().state]),
    );
    for (const entry of listeners) {
      try {
        entry.listener(scoped(entry.parentSessionId));
      } catch {
        listeners.delete(entry);
      }
    }
  };
  const makeOwner = async (
    record: StoredOperation,
    manager: ReturnType<typeof SessionManager.create>,
    signal?: AbortSignal,
    reopened = false,
  ) => {
    const spec = { ...record.spec!, cwd: await realpath(record.spec!.cwd) };
    if (!(await lstat(spec.cwd)).isDirectory()) throw new Error("invalid_cwd");
    // Logical run IDs group many children. Native supervisor lease IDs must be
    // unique per child, including when siblings execute in different workspaces.
    const limits = loadSubagentRuntimeConfig(spec.cwd, agentDir);
    const owner = withChildContext(
      { cwd: spec.cwd, agentDir },
      () =>
        new NativeChildOwner(
          {
            name: spec.name,
            task: spec.task,
            cwd: spec.cwd,
            modelOverride: spec.model,
            toolNames: spec.tools,
            systemPrompt: spec.systemPrompt,
            reasoning: spec.reasoning,
            maxTurns: spec.maxTurns,
          },
          {
            cwd: spec.cwd,
            isProjectTrusted: () => new ProjectTrustStore(agentDir).get(spec.cwd) === true,
          },
          manager,
          supervisor,
          {
            runId: reopened ? `${record.operationId}:reopen:${randomUUID()}` : record.operationId,
            signal,
            admission: { scopeId: record.parentSessionId, limits },
          },
        ),
    );
    usageOffsets.set(record.childId, {
      ...(current.children.find((child) => child.childId === record.childId)?.usage ?? zeroUsage()),
    });
    supervisor.retainChild(owner, {
      scopeId: record.parentSessionId,
      maxRetained: limits.maxRetainedJobs,
    });
    nativeIds.set(record.childId, owner.id);
    return owner;
  };
  const executeInitial = async (record: StoredOperation): Promise<StoredResult> => {
    const spec = { ...record.spec!, cwd: await realpath(record.spec!.cwd) };
    if (!(await lstat(spec.cwd)).isDirectory()) throw new Error("invalid_cwd");
    const manager = SessionManager.create(spec.cwd, join(local.directory, "sessions"));
    manager.appendSessionInfo(`sub-${spec.name}`);
    const owner = await makeOwner(
      { ...record, spec },
      manager,
      controllers.get(record.operationId)?.signal,
    );
    await harness!.commit(async (tx) => {
      const store = required((await tx.doc(StoreDoc)).store);
      store.children.find((child) => child.childId === record.childId)!.sessionFile =
        manager.getSessionFile() ?? null;
      store.revision++;
    }, context);
    const result = await owner.runInitial();
    const failed =
      result.details.isError ||
      ["error", "aborted", "length"].includes(result.details.stopReason ?? "");
    return {
      text: result.details.finalOutput,
      preview: bounded(result.details.finalOutput),
      originalJson: JSON.stringify(result),
      disposition: failed ? "failed" : "settled",
    };
  };
  let restoreNative: (record: StoredOperation) => Promise<void>;
  const execute = async (record: StoredOperation): Promise<StoredResult> => {
    if (record.kind === "initial") return executeInitial(record);
    if (record.kind === "reopen") {
      await restoreNative(record);
      return { text: "", preview: bounded(""), originalJson: null, disposition: "reopened" };
    }
    const owner = ownerFor(record.childId);
    if (!owner || owner.summary().state === "closed") throw new Error("native_owner_unavailable");
    const input = record.input!;
    if (controllers.get(record.operationId)?.signal.aborted) throw new Error("operation_cancelled");
    const result = await owner.input(
      input.text,
      NativeInputMode[
        input.mode === "followUp" ? "FollowUp" : input.mode === "steer" ? "Steer" : "Prompt"
      ],
      input.source,
    );
    if (input.mode !== "prompt" || result.outcome === "handled")
      return { text: "", preview: bounded(""), originalJson: null, disposition: result.outcome };
    const messages = [...owner.inspect().messages];
    const answer = messages
      .slice()
      .reverse()
      .find((message) => message.role === "assistant");
    const failed =
      answer?.role === "assistant" && ["error", "aborted", "length"].includes(answer.stopReason);
    const text = getFinalOutput(messages);
    return {
      text,
      preview: bounded(text),
      originalJson: null,
      disposition: failed ? "failed" : result.outcome,
    };
  };
  const executeDispatched = async (
    record: StoredOperation,
    signal: AbortSignal,
    latest: () => Promise<StoredOperation>,
  ) => {
    const isPrompt = record.kind === "initial" || record.kind === "prompt";
    const controller = new AbortController();
    controllers.set(record.operationId, controller);
    if (record.cancelRequested) controller.abort();
    if (isPrompt) active.set(record.childId, record.operationId);
    const abort = () => {
      controller.abort();
      void ownerFor(record.childId)?.cancel();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let result: StoredResult | null = null;
    let failed = false;
    try {
      // Cancellation may have committed before this invocation registered its live controller.
      if ((await latest()).cancelRequested) controller.abort();
      if (!controller.signal.aborted) result = await execute(record);
    } catch (error) {
      failed = true;
      result = executionFailure(record, error);
    } finally {
      signal.removeEventListener("abort", abort);
      controllers.delete(record.operationId);
      if (isPrompt && active.get(record.childId) === record.operationId)
        active.delete(record.childId);
    }
    return { result, failed };
  };
  const settleOperation = (
    store: Store,
    record: StoredOperation,
    result: StoredResult | null,
    failed: boolean,
  ) => {
    const op = operation(store, record.operationId);
    op.status = closing
      ? "interrupted"
      : op.cancelRequested
        ? "cancelled"
        : failed || result?.disposition === "failed"
          ? "failed"
          : "completed";
    op.result = result;
    const child = store.children.find((child) => child.childId === record.childId)!;
    const owner = ownerFor(record.childId);
    if (owner) {
      child.model = owner.summary().model;
      child.usage = addUsage(
        usageOffsets.get(record.childId) ?? zeroUsage(),
        supervisor.usage(owner.runId),
      );
    }
    if (record.kind === "initial" && result?.originalJson) {
      child.initialDetails = initialMetadata(
        (JSON.parse(result.originalJson) as FullResult).details,
        child.sessionFile,
      );
    }
    const inspection = ownerFor(record.childId)?.inspect();
    // Pi's session file is the sole transcript. Persist inspection metadata only.
    op.inspectionJson = JSON.stringify(
      inspection && { ...inspection, messages: [], initialResult: undefined },
    );
    op.inspectionRevision = ++store.revision;
  };
  try {
    await ensureServiceIdentity(local.directory, options.bundleId, agentDir);
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = await lstat(join(local.directory, `service.sqlite${suffix}`)).catch(
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
          throw error;
        },
      );
      if (file && (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.()))
        throw new Error("unsafe_database_file");
    }
    storage = await (options.openStorage ?? openNodeSqliteStorage)(
      join(local.directory, "service.sqlite"),
    );
    const NativeOperation = defineTask<{ operationId: string }, { phase: "execute" }, null>({
      name: "pi-env.subagent.native-operation",
      version: 1,
      initial: () => ({ phase: "execute" }),
      phases: {
        execute: async (task, runtime, taskContext) => {
          let dispatched = false;
          // The durable intent precedes every native hook/model/tool effect. A reopened intent never dispatches again.
          await runtime.commit(async (tx) => {
            const store = required((await tx.doc(StoreDoc)).store);
            const op = operation(store, task.input.operationId);
            if (op.status !== "accepted") return;
            if (op.cancelRequested) {
              op.status = "cancelled";
            } else {
              op.status = "dispatched";
              dispatched = true;
            }
            store.revision++;
            return undefined;
          }, taskContext);
          await publish();
          if (dispatched) {
            const record = structuredClone(
              operation(
                required((await runtime.snapshot(StoreDoc, taskContext))?.store),
                task.input.operationId,
              ),
            );
            const { result, failed } = await executeDispatched(record, runtime.signal, async () =>
              operation(
                required((await runtime.snapshot(StoreDoc, taskContext))?.store),
                record.operationId,
              ),
            );
            await runtime.commit(async (tx) => {
              const store = required((await tx.doc(StoreDoc)).store);
              settleOperation(store, record, result, failed);
              return { status: "terminal", outcome: { status: "completed", result: null } };
            }, taskContext);
          } else {
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
              taskContext,
            );
          }
          await publish();
        },
      },
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    });
    const Cancellation = defineTask<{ operationId: string }, { phase: "cancel" }, null>({
      name: "pi-env.subagent.cancel",
      version: 1,
      initial: () => ({ phase: "cancel" }),
      phases: {
        cancel: async (task, runtime, ctx) => {
          const store = required((await runtime.snapshot(StoreDoc, ctx))?.store);
          const op = operation(store, task.input.operationId);
          controllers.get(op.operationId)?.abort();
          if (active.get(op.childId) === op.operationId) await ownerFor(op.childId)?.cancel();
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            ctx,
          );
        },
      },
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    });
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: "pi-env.subagent.service", tasks: [NativeOperation, Cancellation] }),
    );
    harness = await Harness.open(
      storage,
      {
        models: createModels(),
        registry,
        onReport: (report) => {
          // A terminated or blocked Durable task cannot leave a live application
          // operation waiting forever. Disconnect callers; restart reconciles uncertain
          // dispatches without replaying native effects.
          if (
            [
              "storage_failed",
              "task_faulted",
              "task_interrupted",
              "migration_failed",
              "task_outdated",
              "task_error",
              "host_error",
            ].includes(report.kind)
          )
            fail(report.error);
        },
      },
      context,
    );
    const opened = harness;
    void opened.closed.then((end) => {
      if (end.kind === "failed") fail(end.error);
    });
    await opened.commit(async (tx) => {
      const doc = await tx.doc(StoreDoc);
      doc.store ??= {
        serviceId: randomUUID(),
        bundleId: options.bundleId,
        agentDir,
        revision: 0,
        operations: [],
        children: [],
        closedRuns: [],
        cancellations: [],
      };
      const store = doc.store;
      // The pre-open identity fence rejects incompatible stores. Keep the
      // document fence as an independent consistency check; never migrate or replay.
      if (store.bundleId !== options.bundleId || store.agentDir !== agentDir)
        throw new Error("incompatible_service_bundle");
      for (const op of store.operations) {
        if (op.status === "dispatched") {
          op.status = "interrupted";
          op.result = {
            text: "Native execution interrupted; effects may have occurred.",
            preview: bounded("Native execution interrupted"),
            originalJson: null,
            disposition: "unknown",
          };
        }
      }
      store.revision++;
    }, context);
    await publish();
    const ensureOpen = () => {
      failure.signal.throwIfAborted();
      if (closing) throw new Error("service_closing");
    };
    const assertChildAdmission = (
      store: Store,
      child: Child | null | undefined,
      kind: Operation["kind"],
    ) => {
      if (!child) return;
      if (child.state === "closed") throw new Error("child_closed");
      if (
        kind !== "initial" &&
        kind !== "reopen" &&
        (!ownerFor(child.childId) || ownerFor(child.childId)!.summary().state === "closed")
      )
        throw new Error("explicit_reopen_required");
      if (
        (kind === "prompt" || kind === "reopen") &&
        store.operations.some(
          (op) =>
            op.childId === child.childId &&
            !terminal(op) &&
            (op.kind === "initial" || op.kind === "prompt" || op.kind === "reopen"),
        )
      )
        throw new Error("child_busy");
    };
    const admissionTarget = (
      store: Store,
      parentSessionId: string,
      request: Submit | Input | Reopen,
      kind: Operation["kind"],
    ) => {
      const childId = "childId" in request ? request.childId : randomUUID();
      const child =
        kind === "initial"
          ? null
          : store.children.find(
              (child) => child.childId === childId && child.parentSessionId === parentSessionId,
            );
      if (kind !== "initial" && !child) throw new Error("child_not_found");
      const runId = "task" in request ? request.runId : child!.runId;
      if (closedRun(store, parentSessionId, runId)) throw new Error("run_closed");
      assertChildAdmission(store, child, kind);
      return { childId, runId };
    };
    const restoreChild = async (store: Store, child: Child, key: string, signal?: AbortSignal) => {
      const childId = child.childId;
      const retained = ownerFor(childId);
      if (retained && retained.summary().state !== "closed") return;
      if (!child.sessionFile) throw new Error("historical_session_unavailable");
      const initial = store.operations.find(
        (op) => op.childId === childId && op.kind === "initial",
      )!;
      const owner = await makeOwner(initial, SessionManager.open(child.sessionFile), signal, true);
      try {
        await owner.reopen({
          inputs: historicalInspections.get(childId)?.inputs,
          initialResult: initial.result?.originalJson
            ? (JSON.parse(initial.result.originalJson) as FullResult).details
            : undefined,
        });
        if (closing || closingRuns.has(key)) {
          await owner.close();
          throw new Error(closing ? "service_closing" : "run_closed");
        }
      } catch (error) {
        await owner.close();
        throw error;
      }
      await opened.commit(async (tx) => {
        required((await tx.doc(StoreDoc)).store).revision++;
      }, context);
      await publish();
    };
    restoreNative = async (record) => {
      const child = findChild(record.parentSessionId, record.childId);
      const key = runKey(record.parentSessionId, child.runId);
      if (closingRuns.has(key)) throw new Error("run_closed");
      if (reopening.has(child.childId)) return reopening.get(child.childId)!;
      const pending = (async () => {
        const store = required((await opened.snapshot(StoreDoc, context))?.store);
        if (closedRun(store, record.parentSessionId, child.runId)) throw new Error("run_closed");
        await restoreChild(store, child, key, controllers.get(record.operationId)?.signal);
      })();
      reopening.set(child.childId, pending);
      try {
        await pending;
      } finally {
        reopening.delete(child.childId);
      }
    };
    const admit = async (
      parentSessionId: string,
      request: Submit | Input | Reopen,
      kind: Operation["kind"],
    ): Promise<Receipt> => {
      ensureOpen();
      if (Buffer.byteLength(JSON.stringify(request)) > MaxServiceRequestBytes)
        throw new Error("request_too_large");
      const fingerprint = hash(
        "task" in request
          ? [
              kind,
              request.runId,
              request.name,
              request.task,
              request.cwd,
              request.model,
              request.tools,
              request.systemPrompt,
              request.reasoning,
              request.maxTurns,
            ]
          : "text" in request
            ? [kind, request.childId, request.mode, request.source, request.text]
            : [kind, request.childId],
      );
      const receipt = await opened.commit(async (tx) => {
        const store = required((await tx.doc(StoreDoc)).store);
        if (
          store.cancellations.some(
            (req) => req.parentSessionId === parentSessionId && req.requestId === request.requestId,
          )
        )
          throw new Error("request_conflict");
        const prior = store.operations.find(
          (op) => op.parentSessionId === parentSessionId && op.requestId === request.requestId,
        );
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error("request_conflict");
          return { childId: prior.childId, operationId: prior.operationId };
        }
        if (
          store.operations.length >= maxRetained ||
          store.operations.filter((op) => !terminal(op)).length >= maxOutstanding
        )
          throw new Error("service_capacity");
        const { childId, runId } = admissionTarget(store, parentSessionId, request, kind);
        const operationId = randomUUID();
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const taskId = await tx.createTask(
          NativeOperation,
          { operationId },
          { conversationId: conversation.id, ownership: { kind: "conversation" } },
        );
        const createdAt = new Date().toISOString();
        if (kind === "initial") {
          const spec = request as Submit;
          store.children.push({
            childId,
            parentSessionId,
            runId,
            name: spec.name,
            task: spec.task,
            cwd: spec.cwd,
            createdAt,
            sessionFile: null,
            state: "historical",
          });
        }
        store.operations.push({
          childId,
          operationId,
          parentSessionId,
          runId,
          createdAt,
          requestId: request.requestId,
          fingerprint,
          kind,
          status: "accepted",
          cancelRequested: false,
          result: null,
          taskId,
          spec: kind === "initial" ? (request as Submit) : null,
          input: kind !== "initial" && kind !== "reopen" ? (request as Input) : null,
          inspectionJson: null,
          inspectionRevision: null,
        });
        store.revision++;
        return { childId, operationId };
      }, context);
      await publish();
      opened.resume();
      return receipt;
    };
    const api: ServiceRuntime = {
      failure: failure.signal,
      snapshot: scoped,
      subscribe(parentSessionId, listener) {
        const entry = { parentSessionId, listener };
        listeners.add(entry);
        return () => {
          listeners.delete(entry);
        };
      },
      async submit(parentSessionId, raw) {
        if (!ServiceChecks.scope({ parentSessionId }) || !ServiceChecks.submit(raw))
          throw new Error("invalid_submit");
        if (!isAbsolute(raw.cwd)) throw new Error("absolute_cwd_required");
        const request = structuredClone(raw);
        return admit(parentSessionId, request, "initial");
      },
      async input(parentSessionId, raw) {
        if (!ServiceChecks.input(raw)) throw new Error("invalid_input");
        return admit(parentSessionId, structuredClone(raw), raw.mode);
      },
      async cancel(parentSessionId, raw) {
        ensureOpen();
        if (!ServiceChecks.cancel(raw)) throw new Error("invalid_cancel");
        await opened.commit(async (tx) => {
          const store = required((await tx.doc(StoreDoc)).store);
          if (
            store.operations.some(
              (op) => op.parentSessionId === parentSessionId && op.requestId === raw.requestId,
            )
          )
            throw new Error("request_conflict");
          const prior = store.cancellations.find(
            (req) => req.parentSessionId === parentSessionId && req.requestId === raw.requestId,
          );
          if (prior) {
            if (prior.operationId !== raw.operationId) throw new Error("request_conflict");
            return;
          }
          if (store.cancellations.length >= maxRetained) throw new Error("service_capacity");
          const op = scopedOperation(store, parentSessionId, raw.operationId);
          if (op.status === "dispatched" && (op.kind === "steer" || op.kind === "followUp"))
            throw new Error("input_already_dispatched");
          store.cancellations.push({
            requestId: raw.requestId,
            operationId: raw.operationId,
            parentSessionId,
          });
          if (!terminal(op)) {
            op.cancelRequested = true;
            const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
            await tx.createTask(
              Cancellation,
              { operationId: op.operationId },
              { conversationId: conversation.id, ownership: { kind: "conversation" } },
            );
          }
          store.revision++;
        }, context);
        await publish();
        opened.resume();
      },
      async result(parentSessionId, input) {
        if (!ServiceChecks.result(input)) throw new Error("invalid_result_request");
        const op = scopedOperation(
          required((await opened.snapshot(StoreDoc, context))?.store),
          parentSessionId,
          input.operationId,
        );
        const text = op.result?.text ?? "";
        const child = current.children.find((item) => item.childId === op.childId);
        const page = pageText(text, input);
        return {
          operationId: op.operationId,
          status: op.status,
          ...page,
          disposition: op.result?.disposition ?? (terminal(op) ? "unknown" : "pending"),
          ...(op.kind === "initial" && child?.initialDetails
            ? { initialDetails: child.initialDetails }
            : {}),
        };
      },
      inspect(parentSessionId, childId, options) {
        const child = findChild(parentSessionId, childId);
        const owner = ownerFor(childId);
        const saved = historicalInspections.get(childId);
        const snapshot = owner
          ? owner.inspect()
          : saved && {
              ...saved,
              messages: child.sessionFile
                ? SessionManager.open(child.sessionFile).buildSessionContext().messages
                : [],
              initialResult: child.initialDetails && {
                ...child.initialDetails,
                modelOverride: child.initialDetails.modelOverride,
                task: child.task,
                finalOutput: "",
              },
              state: child.state === "closed" ? ("closed" as const) : ("historical" as const),
            };
        return snapshot ? inspectionPage(snapshot, options) : null;
      },
      async reopen(parentSessionId, request) {
        if (!ServiceChecks.reopen(request)) throw new Error("invalid_reopen");
        return admit(parentSessionId, structuredClone(request), "reopen");
      },
      async closeRun(runId, parentSessionId) {
        ensureOpen();
        const key = runKey(parentSessionId, runId);
        closingRuns.add(key);
        try {
          await opened.commit(async (tx) => {
            const store = required((await tx.doc(StoreDoc)).store);
            if (
              !store.closedRuns.some(
                (run) => run.runId === runId && run.parentSessionId === parentSessionId,
              )
            )
              store.closedRuns.push({ runId, parentSessionId });
            for (const op of store.operations) {
              if (op.parentSessionId !== parentSessionId || op.runId !== runId || terminal(op))
                continue;
              if (op.status === "dispatched" && (op.kind === "steer" || op.kind === "followUp"))
                continue;
              op.cancelRequested = true;
              if (op.status === "accepted") op.status = "cancelled";
            }
            store.revision++;
          }, context);
          await publish();
          const belongs = (op: Operation) =>
            op.parentSessionId === parentSessionId && op.runId === runId;
          for (const op of current.operations.filter(belongs))
            controllers.get(op.operationId)?.abort();
          const children = current.children.filter(
            (child) => child.parentSessionId === parentSessionId && child.runId === runId,
          );
          // A failed reopen already closes its partial owner; it must not skip
          // settlement and closure of the other children in this run.
          await Promise.allSettled(
            children.flatMap((child) => {
              const pending = reopening.get(child.childId);
              return pending ? [pending] : [];
            }),
          );
          const owners = children.flatMap((child) => {
            const owner = ownerFor(child.childId);
            return owner ? [owner] : [];
          });
          await Promise.all(owners.map((owner) => owner.cancel()));
          await new Promise<void>((resolve) => {
            const settled = () => !current.operations.some((op) => belongs(op) && !terminal(op));
            if (settled()) {
              resolve();
              return;
            }
            const stop = api.subscribe(parentSessionId, () => {
              if (settled()) {
                stop();
                resolve();
              }
            });
          });
          await Promise.all(owners.map((owner) => owner.close()));
          await opened.commit(async (tx) => {
            const store = required((await tx.doc(StoreDoc)).store);
            for (const child of store.children)
              if (child.parentSessionId === parentSessionId && child.runId === runId)
                child.state = "closed";
            store.revision++;
          }, context);
          await publish();
        } finally {
          closingRuns.delete(key);
        }
      },
      close() {
        return (closePromise ??= (async () => {
          closing = true;
          clearInterval(summaryObserver);
          const outcomes = await Promise.allSettled([opened.close(context), supervisor.shutdown()]);
          listeners.clear();
          await release();
          const failures = outcomes.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
          if (failures.length)
            throw new AggregateError(failures, "Subagent service shutdown failed");
        })());
      },
    };
    // Native owners expose summary reads, not state-change subscriptions. Observe
    // only metadata so queued/running/evicted transitions reach Chord even while
    // a native hook or tool blocks. Never subscribe clients to native transcripts.
    summaryObserver = setInterval(() => {
      if (closing || observingSummary || listeners.size === 0) return;
      const changed =
        supervisor.children.size !== publishedNativeStates.size ||
        [...supervisor.children].some(
          ([id, owner]) => publishedNativeStates.get(id) !== owner.summary().state,
        );
      if (!changed) return;
      observingSummary = true;
      void opened
        .commit(async (tx) => {
          required((await tx.doc(StoreDoc)).store).revision++;
        }, context)
        .then(publish)
        .catch((error: unknown) => {
          if (!closing) console.error("Subagent summary publication failed", error);
        })
        .finally(() => {
          observingSummary = false;
        });
    }, 25);
    summaryObserver.unref();
    closeRuntime = () => api.close();
    opened.resume();
    return api;
  } catch (error) {
    const outcomes = await Promise.allSettled([
      supervisor.shutdown(),
      harness ? harness.close(context) : storage?.close(context),
    ]);
    await release();
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length)
      throw new AggregateError([error, ...failures], "Service startup and cleanup failed", {
        cause: error,
      });
    throw error;
  }
}
