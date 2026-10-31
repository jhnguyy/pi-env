import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Layer, Scope } from "effect";
import {
  DagExecutorRegistryLayer,
  DagRuntimeLive,
  DagRuntimeNotAccepting,
  DagRuntimeCoordinatorFatal,
  DagRuntimeRunAlreadyExists,
  createDagSessionWriter,
  reconstructDagSession,
  submitDagRun,
  type DagExecutorRegistry,
  type DagExecutorRegistryService,
  type DagRunHandle,
  type DagRuntimeJournal,
  type DagRuntimeService,
  type DagSessionStore,
  type ValidatedDagDefinition,
} from "../../../src/dag/index.js";
import type { ToolingTelemetryRuntime } from "../../../src/telemetry/tooling";
import { removeDagExecutorsForSessionGeneration } from "../_shared/dag-executor-registration";
import {
  dagUsagePrefix,
  registerDagRuntimeService,
  unregisterDagRuntimeService,
  type DagRuntimeServiceRegistration,
  type DagRuntimeSubmissionAuthority,
  type DagRuntimeUsage,
} from "../_shared/dag-runtime-service";
import type { SubagentServiceConnection } from "./service-host";
import { createDagSubagentExecutorRegistry } from "./dag-runtime";
import { createDagSessionStore, persistedDagRunIds } from "./dag-session-store";
import { addUsage, zeroUsage, type SubagentUsageLedger } from "./usage";

export type DagSubagentExecutorRegistryFactory = typeof createDagSubagentExecutorRegistry;

interface DagSessionRuntimeDependencies {
  readonly sessionGeneration: string;
  readonly serviceConnection: SubagentServiceConnection;
  readonly telemetryRuntime: ToolingTelemetryRuntime;
  readonly ledger: SubagentUsageLedger;
  readonly executorRegistry?: DagExecutorRegistryService;
  readonly executorRegistryFactory?: DagSubagentExecutorRegistryFactory;
}

export class DagSessionRuntime {
  private readonly activeRuns = new Set<DagRunHandle>();
  private readonly pendingSubmissions = new Set<Promise<void>>();
  private readonly registration: DagRuntimeServiceRegistration;
  private accepting = true;
  private disposePromise: Promise<void> | undefined;

  private constructor(
    private readonly pi: ExtensionAPI,
    private readonly store: DagSessionStore,
    private readonly scope: Scope.Closeable,
    private readonly runtimeLayer: Layer.Layer<DagExecutorRegistry | DagRuntimeService>,
    private readonly claimedRunIds: Set<string>,
    private readonly authorities: Map<string, DagRuntimeSubmissionAuthority>,
    private readonly serviceConnection: SubagentServiceConnection,
    private readonly ledger: SubagentUsageLedger,
    private readonly parentSessionId: string,
    private readonly sessionGeneration: string,
    ctx: ExtensionContext,
  ) {
    const service = Object.freeze({
      submit: <TPayload>(
        graph: ValidatedDagDefinition<TPayload>,
        authority?: DagRuntimeSubmissionAuthority,
      ) => this.submit(graph, authority),
      reconstruct: (runId: string) => reconstructDagSession(this.store, runId),
      closeChildren: async (runId: string): Promise<void> => {
        await this.serviceConnection.view.closeRun({ runId });
      },
      usage: (runId: string): DagRuntimeUsage => {
        const prefix = dagUsagePrefix(runId);
        return Object.freeze(this.ledger.rows()
          .filter((row) => row.id.startsWith(prefix))
          .reduce((total, row) => addUsage(total, row.usage), zeroUsage()));
      },
    });
    this.registration = registerDagRuntimeService(pi, {
      parentSessionId: ctx.sessionManager.getSessionId(),
      sessionGeneration: this.sessionGeneration,
      service,
    });
  }

  static async create(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    dependencies: DagSessionRuntimeDependencies,
  ): Promise<DagSessionRuntime> {
    const parentSessionId = ctx.sessionManager.getSessionId();
    const artifactRoot = path.join(
      ctx.sessionManager.getSessionDir(),
      "dag-artifacts",
      parentSessionId,
    );
    const authorities = new Map<string, DagRuntimeSubmissionAuthority>();
    const writableSessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
      appendCustomEntry(customType: string, data?: unknown): string;
    };
    const store = createDagSessionStore(writableSessionManager);
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const registry =
      dependencies.executorRegistry ??
      (dependencies.executorRegistryFactory ?? createDagSubagentExecutorRegistry)(
        ctx,
        artifactRoot,
        dependencies.sessionGeneration,
        {
          workspaceRootForRun: (runId) => authorities.get(runId)?.workspaceRoot,
          reviewCapabilityForRun: async (runId) => {
            const descriptor = authorities.get(runId)?.reviewCapability;
            if (!descriptor) return undefined;
            const reconstruction = await Effect.runPromise(reconstructDagSession(store, runId));
            // Replay failures can contain Error instances; transport only their data.
            return structuredClone({ ...descriptor, reconstruction: JSON.parse(JSON.stringify(reconstruction)) });
          },
          ledger: dependencies.ledger,
          serviceConnection: dependencies.serviceConnection,
          telemetryRuntime: dependencies.telemetryRuntime,
        },
      );
    const scope = await Effect.runPromise(Scope.make());
    try {
      return new DagSessionRuntime(
        pi,
        store,
        scope,
        Layer.mergeAll(DagRuntimeLive, DagExecutorRegistryLayer(registry)),
        persistedDagRunIds(store),
        authorities,
        dependencies.serviceConnection,
        dependencies.ledger,
        parentSessionId,
        dependencies.sessionGeneration,
        ctx,
      );
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw cause;
    }
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  dispose(): Promise<void> {
    this.stopAccepting();
    this.disposePromise ??= (async () => {
      try {
        await Promise.all([...this.pendingSubmissions]);
        const handles = [...this.activeRuns];
        await Effect.runPromise(
          Effect.forEach(handles, (handle) => Effect.result(handle.cancel), {
            concurrency: "unbounded",
            discard: true,
          }),
        );
        await Effect.runPromise(Scope.close(this.scope, Exit.void));
      } finally {
        this.activeRuns.clear();
        this.authorities.clear();
        removeDagExecutorsForSessionGeneration(this.parentSessionId, this.sessionGeneration);
        try {
          unregisterDagRuntimeService(this.pi, this.registration);
        } catch {
          // The registration is already removed. A consumer failure must not stop owner cleanup.
        }
      }
    })();
    return this.disposePromise;
  }

  private submit<TPayload>(
    graph: ValidatedDagDefinition<TPayload>,
    authority?: DagRuntimeSubmissionAuthority,
  ) {
    return Effect.suspend(() => {
      if (!this.accepting) {
        return Effect.fail(
          new DagRuntimeNotAccepting({ message: "The session DAG runtime is shutting down." }),
        );
      }
      if (authority?.customTools?.length) {
        return Effect.fail(new DagRuntimeNotAccepting({
          message: "Arbitrary custom ToolDefinitions are unsupported; supply a data-only review capability.",
        }));
      }
      if (authority?.reviewCapability && authority.reviewCapability.runId !== graph.runId) {
        return Effect.fail(new DagRuntimeNotAccepting({ message: "Review capability does not match the DAG run." }));
      }
      if (this.claimedRunIds.has(graph.runId)) {
        return Effect.fail(
          new DagRuntimeRunAlreadyExists({
            message: "The parent session already contains this DAG run ID.",
            runId: graph.runId,
          }),
        );
      }
      let detachedAuthority: DagRuntimeSubmissionAuthority | undefined;
      try {
        detachedAuthority = authority ? structuredClone(authority) : undefined;
      } catch {
        return Effect.fail(new DagRuntimeNotAccepting({ message: "DAG authority must be data-only." }));
      }
      this.claimedRunIds.add(graph.runId);
      if (detachedAuthority) this.authorities.set(graph.runId, detachedAuthority);
      let resolveSubmission!: () => void;
      const pendingSubmission = new Promise<void>((resolve) => {
        resolveSubmission = resolve;
      });
      this.pendingSubmissions.add(pendingSubmission);
      const finishSubmission = Effect.sync(() => {
        this.pendingSubmissions.delete(pendingSubmission);
        resolveSubmission();
      });
      const writer = createDagSessionWriter(this.store, graph, graph);
      let graphPersisted = false;
      const journal: DagRuntimeJournal = {
        beforeRun: (definition) =>
          writer.appendGraph(definition).pipe(
            Effect.tap(() => Effect.sync(() => (graphPersisted = true))),
            Effect.onExit(() =>
              Effect.sync(() => {
                if (!graphPersisted) {
                  this.claimedRunIds.delete(graph.runId);
                  this.authorities.delete(graph.runId);
                }
              }),
            ),
            Effect.asVoid,
          ),
        appendTransition: (transition, attempt) =>
          writer.appendTransition(transition, attempt).pipe(Effect.asVoid),
        appendFinal: (outcome) => writer.appendFinal(outcome).pipe(Effect.asVoid),
      };
      return submitDagRun(graph, undefined, { journal }).pipe(
        Effect.provide(this.runtimeLayer),
        Scope.provide(this.scope),
        Effect.tap((handle) =>
          Effect.sync(() => this.activeRuns.add(handle)).pipe(
            Effect.andThen(
              handle.await.pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    this.activeRuns.delete(handle);
                    this.authorities.delete(graph.runId);
                  }),
                ),
                Effect.forkIn(this.scope),
              ),
            ),
          ),
        ),
        Effect.map((handle) => {
          const removeAfterTerminal = <A, E>(effect: Effect.Effect<A, E>) =>
            effect.pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                  ? Effect.void
                  : Effect.sync(() => {
                      this.activeRuns.delete(handle);
                      this.authorities.delete(graph.runId);
                    }),
              ),
            );
          return Object.freeze({
            accepted: handle.accepted,
            snapshot: handle.snapshot,
            await: removeAfterTerminal(handle.await),
            cancel: removeAfterTerminal(
              handle.cancel.pipe(
                Effect.tap(() => Effect.tryPromise({
                  try: () => this.serviceConnection.view.closeRun({ runId: graph.runId }),
                  catch: (cause) => new DagRuntimeCoordinatorFatal({
                    message: "Native DAG cancellation could not settle its service run.", cause,
                  }),
                })),
              ),
            ),
          } satisfies DagRunHandle);
        }),
        Effect.ensuring(finishSubmission),
      );
    });
  }
}
