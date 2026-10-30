import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { ProjectTrustStore, SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Harness, createRegistry, defineDoc, defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Check } from "typebox/value";
import { withChildContext } from "../../.pi/extensions/_shared/child-context.js";
import { resolveSubagentRuntimeConfig } from "../../.pi/extensions/subagent/config.js";
import { SubagentRunSupervisor } from "../../.pi/extensions/subagent/control.js";
import { NativeChildOwner } from "../../.pi/extensions/subagent/native-child.js";
import { NativeInputMode } from "../../.pi/extensions/subagent/child-types.js";
import { getFinalOutput } from "../../.pi/extensions/subagent/usage.js";
import { CancelSchema, InputSchema, SubmitSchema, type Cancel, type Input, type Operation, type Receipt, type ServiceRuntime, type Snapshot, type Submit } from "./contract.js";

type StoredOperation = Operation & {
  requestId: string;
  fingerprint: string;
  spec: Submit | null;
  input: Input | null;
  sessionFile: string | null;
  taskId: TaskId<null> | null;
};
type Store = {
  serviceId: string;
  bundleId: string;
  agentDir: string;
  revision: number;
  operations: StoredOperation[];
  cancellations: { requestId: string; operationId: string }[];
};
const StoreDoc = defineDoc<{ store: Store | null }>({
  kind: "pi-env.subagent.service", version: 1, scope: "session",
  initial: () => ({ store: null }), checkpointWhen: () => true,
});
const terminal = (op: Operation) => op.status !== "accepted" && op.status !== "dispatched";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function bounded(text: string, limit = 4_096): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  return { text: bytes.length > limit ? bytes.subarray(0, limit - 4).toString("utf8").replace(/\uFFFD$/, "") + "…" : text, truncated: bytes.length > limit };
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
async function privateDirectory(directory: string): Promise<{ directory: string; lock: string }> {
  if (process.platform !== "linux") throw new Error("unsupported_platform");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const fs = await statfs(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("private_state_directory_required");
  if (![0xef53, 0x58465342, 0x9123683e, 0x794c7630, 0x2fc12fc1, 0x01021994].includes(fs.type))
    throw new Error("local_state_filesystem_required");
  return { directory: await realpath(directory), lock: `pi-env.subagents:${info.dev}:${info.ino}` };
}

/** Promise compatibility boundary for native Pi, Chord and Durable. The service owns every execution signal. */
export async function openServiceRuntime(options: {
  directory: string;
  bundleId: string;
  agentDir?: string;
}): Promise<ServiceRuntime> {
  if (!/^[a-f0-9]{64}$/.test(options.bundleId)) throw new Error("executable_digest_required");
  const local = await privateDirectory(options.directory);
  const agentDir = await realpath(options.agentDir ?? getAgentDir());
  const release = await processLock(local.lock);
  const epoch = randomUUID();
  const supervisor = new SubagentRunSupervisor(`service:${epoch}`, resolveSubagentRuntimeConfig({}));
  const nativeIds = new Map<string, string>();
  const ownerFor = (childId: string) => supervisor.children.get(nativeIds.get(childId) ?? "");
  const active = new Map<string, string>();
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let harness: Harness | undefined;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let current: Snapshot = { serviceId: "opening", epoch, revision: 0, operations: [] };
  const publish = async () => {
    const store = required((await harness!.snapshot(StoreDoc, context))?.store);
    const next: Snapshot = {
      serviceId: store.serviceId, epoch, revision: store.revision,
      operations: store.operations.map(({ childId, operationId, kind, status, cancelRequested, result }) => ({ childId, operationId, kind, status, cancelRequested, result: result && { ...result } })),
    };
    if (next.revision < current.revision) return;
    current = next;
    for (const listener of listeners) {
      try { listener(structuredClone(current)); }
      catch { listeners.delete(listener); }
    }
  };
  const executeInitial = async (record: StoredOperation): Promise<Operation["result"]> => {
    const spec = { ...record.spec!, cwd: await realpath(record.spec!.cwd) };
    if (!(await lstat(spec.cwd)).isDirectory()) throw new Error("invalid_cwd");
    const manager = SessionManager.create(spec.cwd, join(local.directory, "sessions"));
    manager.appendSessionInfo(`sub-${spec.name}`);
    const owner = withChildContext({ cwd: spec.cwd, agentDir }, () => new NativeChildOwner({
      name: spec.name, task: spec.task, cwd: spec.cwd,
      modelOverride: spec.model, toolNames: spec.tools, systemPrompt: spec.systemPrompt,
    }, { cwd: spec.cwd, isProjectTrusted: () => new ProjectTrustStore(agentDir).get(spec.cwd) === true }, manager, supervisor, { runId: record.operationId, signal: controllers.get(record.operationId)?.signal }));
    supervisor.retainChild(owner);
    nativeIds.set(record.childId, owner.id);
    await harness!.commit(async (tx) => {
      const store = required((await tx.doc(StoreDoc)).store);
      operation(store, record.operationId).sessionFile = manager.getSessionFile() ?? null;
      store.revision++;
    }, context);
    const result = await owner.runInitial();
    const failed = result.details.isError || ["error", "aborted", "length"].includes(result.details.stopReason ?? "");
    return { ...bounded(result.details.finalOutput), disposition: failed ? "failed" : "settled" };
  };
  const execute = async (record: StoredOperation): Promise<Operation["result"]> => {
    if (record.kind === "initial") return executeInitial(record);
    const owner = ownerFor(record.childId);
    if (!owner || owner.summary().state === "closed") throw new Error("native_owner_unavailable");
    const input = record.input!;
    if (controllers.get(record.operationId)?.signal.aborted) throw new Error("operation_cancelled");
    const result = await owner.input(input.text, NativeInputMode[input.mode === "followUp" ? "FollowUp" : input.mode === "steer" ? "Steer" : "Prompt"]);
    if (input.mode !== "prompt" || result.outcome === "handled") return { text: "", truncated: false, disposition: result.outcome };
    const messages = [...owner.inspect().messages];
    const answer = messages.slice().reverse().find((message) => message.role === "assistant");
    const failed = answer?.role === "assistant" && ["error", "aborted", "length"].includes(answer.stopReason);
    return { ...bounded(getFinalOutput(messages)), disposition: failed ? "failed" : result.outcome };
  };
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = await lstat(join(local.directory, `service.sqlite${suffix}`)).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (file && (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.())) throw new Error("unsafe_database_file");
    }
    storage = await openNodeSqliteStorage(join(local.directory, "service.sqlite"));
    const NativeOperation = defineTask<{ operationId: string }, { phase: "execute" }, null>({
      name: "pi-env.subagent.native-operation", version: 1, initial: () => ({ phase: "execute" }),
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
          }, taskContext);
          await publish();
          if (dispatched) {
            const record = structuredClone(operation(required((await runtime.snapshot(StoreDoc, taskContext))?.store), task.input.operationId));
            const isPrompt = record.kind === "initial" || record.kind === "prompt";
            const controller = new AbortController();
            controllers.set(record.operationId, controller);
            if (record.cancelRequested) controller.abort();
            if (isPrompt) active.set(record.childId, record.operationId);
            const abort = () => {
              controller.abort();
              void ownerFor(record.childId)?.cancel();
            };
            runtime.signal.addEventListener("abort", abort, { once: true });
            if (runtime.signal.aborted) abort();
            let result: Operation["result"] = null;
            let failed = false;
            try {
              // Cancellation may have committed before this invocation registered its live controller.
              const latest = operation(required((await runtime.snapshot(StoreDoc, taskContext))?.store), record.operationId);
              if (latest.cancelRequested) controller.abort();
              if (!controller.signal.aborted) result = await execute(record);
            }
            catch {
              failed = true;
              result = { text: "Native execution failed; inspect the retained child when available.", truncated: false, disposition: "failed" };
            }
            finally {
              runtime.signal.removeEventListener("abort", abort);
              controllers.delete(record.operationId);
              if (isPrompt && active.get(record.childId) === record.operationId) active.delete(record.childId);
            }
            await runtime.commit(async (tx) => {
              const store = required((await tx.doc(StoreDoc)).store);
              const op = operation(store, task.input.operationId);
              op.status = closing ? "interrupted" : op.cancelRequested ? "cancelled" : failed || result?.disposition === "failed" ? "failed" : "completed";
              op.result = closing ? { text: "Native execution interrupted; effects may have occurred.", truncated: false, disposition: "unknown" } : result;
              store.revision++;
              return { status: "terminal", outcome: { status: "completed", result: null } };
            }, taskContext);
          } else {
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext);
          }
          await publish();
        },
      },
      abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    });
    const Cancellation = defineTask<{ operationId: string }, { phase: "cancel" }, null>({
      name: "pi-env.subagent.cancel", version: 1, initial: () => ({ phase: "cancel" }),
      phases: { cancel: async (task, runtime, ctx) => {
        const store = required((await runtime.snapshot(StoreDoc, ctx))?.store);
        const op = operation(store, task.input.operationId);
        controllers.get(op.operationId)?.abort();
        if (active.get(op.childId) === op.operationId) await ownerFor(op.childId)?.cancel();
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
      } },
      abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "pi-env.subagent.service", tasks: [NativeOperation, Cancellation] }));
    harness = await Harness.open(storage, { models: createModels(), registry }, context);
    const opened = harness;
    await opened.commit(async (tx) => {
      const doc = await tx.doc(StoreDoc);
      doc.store ??= { serviceId: randomUUID(), bundleId: options.bundleId, agentDir, revision: 0, operations: [], cancellations: [] };
      const store = doc.store;
      if (store.bundleId !== options.bundleId || store.agentDir !== agentDir) throw new Error("incompatible_service_bundle");
      for (const op of store.operations) {
        if (op.status === "dispatched") {
          op.status = "interrupted";
          op.result = { text: "Native execution interrupted; effects may have occurred.", truncated: false, disposition: "unknown" };
        }
      }
      store.revision++;
    }, context);
    await publish();
    const ensureOpen = () => { if (closing) throw new Error("service_closing"); };
    const admit = async (request: Submit | Input, kind: Operation["kind"]): Promise<Receipt> => {
      ensureOpen();
      if (Buffer.byteLength(JSON.stringify(request)) > 65_536) throw new Error("request_too_large");
      const fingerprint = hash("task" in request
        ? [kind, request.requestId, request.name, request.task, request.cwd, request.model ?? null, request.tools ?? null, request.systemPrompt ?? null]
        : [kind, request.requestId, request.childId, request.text]);
      const receipt = await opened.commit(async (tx) => {
        const store = required((await tx.doc(StoreDoc)).store);
        if (store.cancellations.some((req) => req.requestId === request.requestId)) throw new Error("request_conflict");
        const prior = store.operations.find((op) => op.requestId === request.requestId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error("request_conflict");
          return { childId: prior.childId, operationId: prior.operationId };
        }
        if (store.operations.length >= 128 || store.operations.filter((op) => !terminal(op)).length >= 20) throw new Error("service_capacity");
        const childId = "childId" in request ? request.childId : randomUUID();
        if (kind !== "initial" && !store.operations.some((op) => op.childId === childId && op.kind === "initial")) throw new Error("child_not_found");
        if (kind === "prompt" && store.operations.some((op) => op.childId === childId && !terminal(op) && (op.kind === "initial" || op.kind === "prompt"))) throw new Error("child_busy");
        const operationId = randomUUID();
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const taskId = await tx.createTask(NativeOperation, { operationId }, { conversationId: conversation.id, ownership: { kind: "conversation" } });
        store.operations.push({ childId, operationId, requestId: request.requestId, fingerprint, kind, status: "accepted", cancelRequested: false, result: null, taskId, spec: kind === "initial" ? request as Submit : null, input: kind !== "initial" ? request as Input : null, sessionFile: null });
        store.revision++;
        return { childId, operationId };
      }, context);
      await publish();
      opened.resume();
      return receipt;
    };
    const api: ServiceRuntime = {
      snapshot: () => structuredClone(current),
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async submit(raw) {
        if (!Check(SubmitSchema, raw)) throw new Error("invalid_submit");
        if (!isAbsolute(raw.cwd)) throw new Error("absolute_cwd_required");
        return admit({
          requestId: raw.requestId, name: raw.name, task: raw.task, cwd: raw.cwd,
          ...(raw.model !== undefined ? { model: raw.model } : {}),
          ...(raw.tools !== undefined ? { tools: [...raw.tools] } : {}),
          ...(raw.systemPrompt !== undefined ? { systemPrompt: raw.systemPrompt } : {}),
        }, "initial");
      },
      async input(raw) {
        if (!Check(InputSchema, raw)) throw new Error("invalid_input");
        return admit(structuredClone(raw), raw.mode);
      },
      async cancel(raw) {
        ensureOpen();
        if (!Check(CancelSchema, raw)) throw new Error("invalid_cancel");
        await opened.commit(async (tx) => {
          const store = required((await tx.doc(StoreDoc)).store);
          if (store.operations.some((op) => op.requestId === raw.requestId)) throw new Error("request_conflict");
          const prior = store.cancellations.find((req) => req.requestId === raw.requestId);
          if (prior) {
            if (prior.operationId !== raw.operationId) throw new Error("request_conflict");
            return;
          }
          if (store.cancellations.length >= 128) throw new Error("service_capacity");
          const op = operation(store, raw.operationId);
          if (op.status === "dispatched" && (op.kind === "steer" || op.kind === "followUp")) throw new Error("input_already_dispatched");
          store.cancellations.push({ requestId: raw.requestId, operationId: raw.operationId });
          if (!terminal(op)) {
            op.cancelRequested = true;
            const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
            await tx.createTask(Cancellation, { operationId: op.operationId }, { conversationId: conversation.id, ownership: { kind: "conversation" } });
          }
          store.revision++;
        }, context);
        await publish();
        opened.resume();
      },
      inspect(childId) {
        const owner = ownerFor(childId);
        const initial = current.operations.find((op) => op.childId === childId && op.kind === "initial");
        if (!initial) throw new Error("child_not_found");
        return bounded(JSON.stringify({ initial, native: owner?.inspect() ?? null }), 16_384).text;
      },
      close() {
        return closePromise ??= (async () => {
          closing = true;
          const outcomes = await Promise.allSettled([opened.close(context), supervisor.shutdown()]);
          listeners.clear();
          await release();
          const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
          if (failures.length) throw new AggregateError(failures, "Subagent service shutdown failed");
        })();
      },
    };
    opened.resume();
    return api;
  } catch (error) {
    const outcomes = await Promise.allSettled([supervisor.shutdown(), harness ? harness.close(context) : storage?.close(context)]);
    await release();
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError([error, ...failures], "Service startup and cleanup failed", { cause: error });
    throw error;
  }
}
