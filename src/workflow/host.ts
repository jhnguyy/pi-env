import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, statfs } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/node";
import { createModels, createProvider, type Provider } from "@earendil-works/pi-ai/models";
import {
  Harness,
  configure,
  createRegistry,
  defineDoc,
  defineDocFamily,
  type ModelRef,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  digest,
  registerDefinitions,
  TextMaxBytes,
  ThreeStageWorkflow,
  workflowKey,
} from "./definition.js";
import {
  CapacityDoc,
  CompletionTask,
  readRun,
  RunDoc,
  RunReferenceSchema,
  SegmentTask,
  WorkflowTasks,
  type RunReference,
  type RunState,
} from "./runtime.js";

const Identity = Type.String({ minLength: 1, maxLength: 128 });
const Request = Type.Object(
  {
    principal: Identity,
    requestId: Identity,
    workflow: Identity,
    version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    input: Type.Object(
      { text: Type.String({ minLength: 1, maxLength: TextMaxBytes }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const Model = Type.Object(
  { provider: Identity, modelId: Identity },
  { additionalProperties: false },
);
const StoreDoc = defineDoc<{ identity: { serviceId: string; fingerprint: string } | null }>({
  kind: "pi-env.workflow.store",
  version: 1,
  scope: "session",
  initial: () => ({ identity: null }),
  checkpointWhen: () => true,
});
const RequestDoc = defineDocFamily<
  {
    accepted: {
      fingerprint: string;
      reference: RunReference;
      segmentTaskId: TaskId<null>;
      completionTaskId: TaskId<null>;
    } | null;
  },
  null
>({
  kind: "pi-env.workflow.request",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ accepted: null }),
  checkpointWhen: () => true,
});

export type WorkflowHost = {
  submit(value: unknown): Promise<RunReference>;
  status(principal: string, reference: unknown): Promise<Readonly<RunState>>;
  wait(principal: string, reference: unknown): Promise<Readonly<RunState>>;
  close(): Promise<void>;
};

// The proof supports Linux local filesystems. Unknown types fail closed rather than silently accepting network WAL.
const LocalFilesystemTypes = new Set([
  0xef53, 0x58465342, 0x9123683e, 0x794c7630, 0x2fc12fc1, 0x01021994,
]);
async function localDirectory(path: string): Promise<{ path: string; lock: string }> {
  if (process.platform !== "linux")
    throw new Error("unsupported_storage: the proof requires Linux");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const [stats, filesystem] = await Promise.all([
    lstat(canonical, { bigint: true }),
    statfs(canonical),
  ]);
  if (
    !stats.isDirectory() ||
    stats.uid !== BigInt(process.getuid?.() ?? -1) ||
    (stats.mode & 0o077n) !== 0n
  )
    throw new Error("unsupported_storage: use a private state directory owned by this user");
  if (!LocalFilesystemTypes.has(filesystem.type))
    throw new Error(
      "unsupported_storage: use a verified local filesystem, not network storage",
    );
  return { path: canonical, lock: `pi-env.workflow:${stats.dev}:${stats.ino}` };
}

async function managedFiles(directory: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    const stats = await lstat(join(directory, `workflow.sqlite${suffix}`)).catch(
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (stats && (!stats.isFile() || stats.nlink !== 1 || stats.uid !== process.getuid?.()))
      throw new Error("unsupported_storage: database files must not be aliases or links");
  }
}

/** Trusted embedding boundary, not a network server. The caller must authenticate the supplied principal. */
export async function openWorkflowHost(options: {
  directory: string;
  bundleId: string;
  provider: Provider;
  model: ModelRef;
  definitions?: readonly unknown[];
}): Promise<WorkflowHost> {
  if (!/^[a-f0-9]{64}$/.test(options.bundleId) || !Check(Model, options.model))
    throw new Error("invalid_configuration: supply the executable SHA-256 and exact model");
  const definitions = registerDefinitions(options.definitions ?? [ThreeStageWorkflow]);
  const model = structuredClone(options.model);
  const provider = options.provider;
  const resolved = provider
    .getModels()
    .find((candidate) => candidate.provider === model.provider && candidate.id === model.modelId);
  if (provider.id !== model.provider || !resolved)
    throw new Error("invalid_configuration: pinned model is unavailable");
  const pinnedModel = structuredClone(resolved);
  // Own a static collection. Caller catalog refresh/replacement must not change admitted execution.
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      headers: { ...provider.headers },
      auth: provider.auth,
      models: [pinnedModel],
      api: {
        stream: provider.stream.bind(provider),
        streamSimple: provider.streamSimple.bind(provider),
        fetchDeferred: provider.fetchDeferred?.bind(provider),
        cancelDeferred: provider.cancelDeferred?.bind(provider),
      },
    }),
  );
  const fingerprint = digest({
    bundleId: options.bundleId,
    model: pinnedModel,
    definitions: [...definitions].sort(([left], [right]) => left.localeCompare(right)),
  });
  const local = await localDirectory(options.directory);
  const directory = local.path;
  const release = await processLock(local.lock);
  let harness: Harness | undefined;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    await managedFiles(directory);
    storage = await openNodeSqliteStorage(join(directory, "workflow.sqlite"));
    const registry = createRegistry();
    registry.install(WorkflowTasks);
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { stream: { timeoutMs: 120_000 }, retry: { maxRetries: 2 } },
      },
      context,
    );
    const opened = harness;
    let closing: Promise<void> | undefined;
    close = () =>
      (closing ??= (async () => {
        // Retain the lock until Harness has stopped all invocations and closed storage.
        try {
          await opened.close(context);
        } finally {
          await release();
        }
      })());
    const identity = await opened.commit(async (tx) => {
      const doc = await tx.doc(StoreDoc);
      if (doc.identity && doc.identity.fingerprint !== fingerprint)
        throw new Error("incompatible_bundle: use the original executable, definitions, and model");
      doc.identity ??= { serviceId: randomUUID(), fingerprint };
      return { ...doc.identity };
    }, context);

    const status = async (principal: string, value: unknown): Promise<Readonly<RunState>> => {
      if (
        !Check(Identity, principal) ||
        !Check(RunReferenceSchema, value) ||
        value.serviceId !== identity.serviceId
      )
        throw new Error("not_found: no accessible run");
      const run = (await opened.snapshot(RunDoc, value.runId, context))?.run;
      if (!run || run.principal !== principal) throw new Error("not_found: no accessible run");
      return structuredClone(readRun(run));
    };

    const host: WorkflowHost = {
      async submit(raw) {
        if (!Check(Request, raw) || Buffer.byteLength(raw.input.text) > TextMaxBytes)
          throw new Error("invalid_request: malformed or oversized workflow input");
        const value = structuredClone(raw);
        const definition = definitions.get(workflowKey(value.workflow, value.version));
        if (!definition) throw new Error("unknown_workflow: this version is not registered");
        const requestFingerprint = digest([
          fingerprint,
          workflowKey(value.workflow, value.version),
          value.input.text,
        ]);
        const reference = await opened.commit(async (tx) => {
          const request = await tx.doc(
            RequestDoc,
            JSON.stringify([value.principal, "submit", value.requestId]),
            null,
          );
          if (request.accepted) {
            if (request.accepted.fingerprint !== requestFingerprint)
              throw new Error("request_conflict: identity was accepted with different content");
            return { ...request.accepted.reference };
          }
          const capacity = await tx.doc(CapacityDoc);
          if (capacity.active !== null)
            throw new Error("busy: no run capacity; retry the same request later");
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, conversation.id, {
            model,
            extensions: [],
            tools: [],
            modelTools: [],
          });
          const segmentTaskId = await tx.createTask(
            SegmentTask,
            { definition, text: value.input.text, model },
            { conversationId: conversation.id, ownership: { kind: "conversation" } },
          );
          const completionTaskId = await tx.createTask(
            CompletionTask,
            { segmentTaskId, presenter: definition.presenter },
            { conversationId: conversation.id, ownership: { kind: "conversation" } },
          );
          const reference = { serviceId: identity.serviceId, runId: conversation.id };
          (await tx.doc(RunDoc, conversation.id)).run = {
            reference,
            principal: value.principal,
            workflow: definition.name,
            version: definition.version,
            segmentTaskId,
            completionTaskId,
            nodes: [],
            status: "running",
            result: null,
            resultEntryId: null,
          };
          request.accepted = {
            fingerprint: requestFingerprint,
            reference,
            segmentTaskId,
            completionTaskId,
          };
          capacity.active = conversation.id;
          return reference;
        }, context);
        opened.resume();
        return reference;
      },
      status,
      async wait(principal, reference) {
        const run = await status(principal, reference);
        await opened.waitForTask(run.completionTaskId, context);
        const completed = await status(principal, run.reference);
        if (completed.status !== "completed")
          throw new Error(
            "completion_failed: run capacity remains reserved; operator intervention required",
          );
        return completed;
      },
      close,
    };
    opened.resume();
    return host;
  } catch (error) {
    try {
      if (close) await close();
      else {
        try {
          await storage?.close(context);
        } finally {
          await release();
        }
      }
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Workflow host open and cleanup failed", {
        cause: cleanup,
      });
    }
    throw error;
  }
}
