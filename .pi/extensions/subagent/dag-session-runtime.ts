import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Layer, Scope } from "effect";
import {
  DagExecutorRegistryLayer,
  DagRuntimeLive,
  DagRuntimeNotAccepting,
  makeDagSessionWriter,
  reconstructDagSession,
  submitDagRun,
  type DagExecutorRegistry,
  type DagRunHandle,
  type DagRuntimeJournal,
  type DagRuntimeService,
  type DagSessionManagerSeam,
  type ValidatedDagDefinition,
} from "../../../src/dag/index.js";
import type { ToolingTelemetryRuntime } from "../../../src/telemetry/tooling";
import {
  registerDagRuntimeService,
  unregisterDagRuntimeService,
  type DagRuntimeServiceRegistration,
} from "../_shared/dag-runtime-service";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import type { SubagentRunSupervisor } from "./control";
import { makeDagSubagentExecutorRegistry } from "./dag-runtime";
import type { SubagentUsageLedger } from "./usage";

interface DagSessionRuntimeDependencies {
  readonly sessionGeneration: string;
  readonly supervisor: SubagentRunSupervisor;
  readonly telemetryRuntime: ToolingTelemetryRuntime;
  readonly ledger: SubagentUsageLedger;
}

export class DagSessionRuntime {
  private readonly activeRuns = new Set<DagRunHandle>();
  private readonly pendingSubmissions = new Set<Promise<void>>();
  private readonly registration: DagRuntimeServiceRegistration;
  private accepting = true;
  private disposePromise: Promise<void> | undefined;

  private constructor(
    private readonly pi: ExtensionAPI,
    private readonly seam: DagSessionManagerSeam,
    private readonly scope: Scope.Closeable,
    private readonly runtimeLayer: Layer.Layer<DagExecutorRegistry | DagRuntimeService>,
    ctx: ExtensionContext,
    sessionGeneration: string,
  ) {
    const service = Object.freeze({
      submit: <TPayload>(graph: ValidatedDagDefinition<TPayload>) => this.submit(graph),
      reconstruct: (runId: string) => reconstructDagSession(this.seam, runId),
    });
    this.registration = registerDagRuntimeService(pi, {
      parentSessionId: ctx.sessionManager.getSessionId(),
      sessionGeneration,
      service,
    });
  }

  static async create(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
    dependencies: DagSessionRuntimeDependencies,
  ): Promise<DagSessionRuntime> {
    const parentSessionId = ctx.sessionManager.getSessionId();
    const artifactRoot = path.join(
      ctx.sessionManager.getSessionDir(),
      "dag-artifacts",
      parentSessionId,
    );
    const registry = makeDagSubagentExecutorRegistry(ctx, registeredExtTools, artifactRoot, {
      ledger: dependencies.ledger,
      supervisor: dependencies.supervisor,
      telemetryRuntime: dependencies.telemetryRuntime,
    });
    const scope = await Effect.runPromise(Scope.make());
    const writableSessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
      appendCustomEntry(customType: string, data?: unknown): string;
    };
    const seam: DagSessionManagerSeam = {
      getBranch: () => writableSessionManager.getBranch(),
      appendCustomEntry: (customType, data) =>
        writableSessionManager.appendCustomEntry(customType, data),
    };
    return new DagSessionRuntime(
      pi,
      seam,
      scope,
      Layer.mergeAll(DagRuntimeLive, DagExecutorRegistryLayer(registry)),
      ctx,
      dependencies.sessionGeneration,
    );
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
        unregisterDagRuntimeService(this.pi, this.registration);
      }
    })();
    return this.disposePromise;
  }

  private submit<TPayload>(graph: ValidatedDagDefinition<TPayload>) {
    return Effect.suspend(() => {
      if (!this.accepting) {
        return Effect.fail(
          new DagRuntimeNotAccepting({ message: "The session DAG runtime is shutting down." }),
        );
      }
      let resolveSubmission!: () => void;
      const pendingSubmission = new Promise<void>((resolve) => {
        resolveSubmission = resolve;
      });
      this.pendingSubmissions.add(pendingSubmission);
      const finishSubmission = Effect.sync(() => {
        this.pendingSubmissions.delete(pendingSubmission);
        resolveSubmission();
      });
      const writer = makeDagSessionWriter(this.seam, graph, graph);
      const journal: DagRuntimeJournal = {
        beforeRun: (definition) => writer.appendGraph(definition).pipe(Effect.asVoid),
        appendTransition: (transition, attempt) =>
          writer.appendTransition(transition, attempt).pipe(Effect.asVoid),
        appendFinal: (outcome) => writer.appendFinal(outcome).pipe(Effect.asVoid),
      };
      return submitDagRun(graph, undefined, { journal }).pipe(
        Effect.provide(this.runtimeLayer),
        Scope.provide(this.scope),
        Effect.map((handle) => {
          this.activeRuns.add(handle);
          const remove = Effect.sync(() => this.activeRuns.delete(handle));
          return Object.freeze({
            snapshot: handle.snapshot,
            await: handle.await.pipe(Effect.ensuring(remove)),
            cancel: handle.cancel.pipe(Effect.ensuring(remove)),
          } satisfies DagRunHandle);
        }),
        Effect.ensuring(finishSubmission),
      );
    });
  }
}
