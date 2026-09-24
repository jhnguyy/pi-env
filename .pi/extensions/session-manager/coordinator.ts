import { access, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Clock, Data, Effect } from "effect";
import type { CoordinatorRecord, SessionCatalogFailure } from "./contracts.js";
import { gcTombstones } from "./schema.js";
import { nameCandidates, selectAvailableName, type NameEntropy } from "./domain.js";
import type { SessionHostError, SessionHostShape } from "./host.js";
import type { ReadyPublication, RestoreOutcome, RestoreSummary } from "./runtime-bus.js";
import { nodeSessionFileProbe, type SessionFileProbe } from "./session-file.js";
import type { SessionCatalogShape } from "./storage.js";

export class CoordinatorUnavailable extends Data.TaggedError("CoordinatorUnavailable")<{
  reason: string;
}> {}
export type CoordinatorError = CoordinatorUnavailable | SessionCatalogFailure | SessionHostError;

const nowIso = Effect.map(Clock.currentTimeMillis, (value) => new Date(value).toISOString());

export function ensureCoordinator(options: {
  readonly catalog: SessionCatalogShape;
  readonly cwd: string;
  readonly entropy: NameEntropy;
}): Effect.Effect<CoordinatorRecord, CoordinatorError> {
  return Effect.gen(function* () {
    const timestamp = yield* nowIso;
    let selected: CoordinatorRecord | undefined;
    const committed = yield* options.catalog.update(options.cwd, (manifest) => {
      const current = gcTombstones(manifest, Date.parse(timestamp));
      if (current.coordinator) {
        selected = current.coordinator;
        return current;
      }
      const name = selectAvailableName(current, nameCandidates(options.entropy), "coordinator-");
      if (!name) throw new CoordinatorUnavailable({ reason: "no coordinator name is available" });
      selected = {
        version: 1,
        sessionId: randomUUID(),
        cwd: current.canonicalCwd,
        name,
        persistence: { state: "pending" },
        createdAt: timestamp,
        lastOpenedAt: timestamp,
        role: "coordinator",
      };
      return { ...current, coordinator: selected };
    });
    return selected ?? committed.coordinator!;
  });
}

export function createWorkspaceReconciler(options: {
  readonly catalog: SessionCatalogShape;
  readonly host: SessionHostShape;
  readonly paneId: string;
  readonly cwd: string;
  readonly workspaceId: string;
  readonly coordinatorSessionId: string;
  readonly wrapperPath: string;
  readonly extensionPath: string;
  readonly readyTimeoutMs?: number;
  readonly sessionFiles?: SessionFileProbe;
}) {
  const ready = new Map<
    string,
    { readonly publication: ReadyPublication; readonly receivedAt: number }
  >();
  const waiters = new Map<string, Set<(publication: ReadyPublication) => void>>();
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const sessionFiles = options.sessionFiles ?? nodeSessionFileProbe;

  const publishReady = async (publication: ReadyPublication): Promise<void> => {
    ready.set(publication.sessionId, { publication, receivedAt: Date.now() });
    for (const resolve of waiters.get(publication.sessionId) ?? []) resolve(publication);
    waiters.delete(publication.sessionId);
  };

  const awaitReady = (sessionId: string, launchId?: string): Promise<boolean> => {
    const present = ready.get(sessionId);
    if (
      present &&
      Date.now() - present.receivedAt <= 15_000 &&
      (!launchId || present.publication.launchId === launchId)
    ) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        listeners.delete(onReady);
        resolve(false);
      }, readyTimeoutMs);
      const onReady = (publication: ReadyPublication) => {
        if (launchId && publication.launchId !== launchId) return;
        clearTimeout(timeout);
        resolve(true);
      };
      const listeners = waiters.get(sessionId) ?? new Set();
      listeners.add(onReady);
      waiters.set(sessionId, listeners);
    });
  };

  const reconcileWorkspace = async (): Promise<RestoreSummary> => {
    const manifest = await Effect.runPromise(options.catalog.read(options.cwd));
    if (!manifest?.coordinator || manifest.coordinator.sessionId !== options.coordinatorSessionId) {
      throw new CoordinatorUnavailable({ reason: "durable coordinator identity does not match" });
    }
    if (!options.host.restoreWindow) {
      throw new CoordinatorUnavailable({
        reason: "session host does not support detached restoration",
      });
    }
    const records = manifest.sessions.filter((record) => record.desiredState === "open");
    const outcomes = await Promise.all(
      records.map(async (record): Promise<RestoreOutcome> => {
        try {
          await access(record.cwd);
          if ((await realpath(record.cwd)) !== manifest.canonicalCwd) {
            throw new Error("working directory does not match the workspace");
          }
          if (record.persistence.state === "materialized") {
            await Effect.runPromise(
              sessionFiles.verify(record.persistence.sessionFile, record.sessionId, record.cwd),
            );
          }
          const launchId = randomUUID();
          const window = await Effect.runPromise(
            options.host.restoreWindow!({
              paneId: options.paneId,
              sessionId: record.sessionId,
              name: record.name,
              ...(record.explicitName ? { explicitName: true as const } : {}),
              cwd: record.cwd,
              wrapperPath: options.wrapperPath,
              extensionPath: options.extensionPath,
              workspaceId: options.workspaceId,
              coordinatorSessionId: options.coordinatorSessionId,
              launchId,
              persistence: record.persistence,
            }),
          );
          const isReady = await awaitReady(
            record.sessionId,
            window.state === "created" ? launchId : undefined,
          );
          if (!isReady) {
            return { sessionId: record.sessionId, name: record.name, state: "timed-out" };
          }
          return {
            sessionId: record.sessionId,
            name: record.name,
            state: window.state === "created" ? "restored" : "active",
          };
        } catch (error) {
          return {
            sessionId: record.sessionId,
            name: record.name,
            state: "failed",
            reason:
              typeof error === "object" && error !== null && "_tag" in error
                ? String((error as { _tag: string })._tag)
                : error instanceof Error
                  ? error.message
                  : String(error),
          };
        }
      }),
    );
    return { outcomes };
  };
  let reconciliation: Promise<unknown> = Promise.resolve();
  const reconcile = (): Promise<RestoreSummary> => {
    const result = reconciliation.then(reconcileWorkspace, reconcileWorkspace);
    reconciliation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return { reconcile, publishReady };
}

export function renderRestoreSummary(summary: RestoreSummary): string {
  if (summary.outcomes.length === 0) return "Workspace restore complete.\n\n0 active";
  const lines = summary.outcomes.map((outcome) => {
    const marker = outcome.state === "failed" || outcome.state === "timed-out" ? "✗" : "✓";
    return `${marker} ${outcome.name.padEnd(24)} ${outcome.state}${outcome.reason ? `: ${outcome.reason}` : ""}`;
  });
  const active = summary.outcomes.filter(
    (outcome) => outcome.state === "active" || outcome.state === "restored",
  ).length;
  const failed = summary.outcomes.length - active;
  return [
    "Workspace restore complete.",
    "",
    ...lines,
    "",
    `${active} active, ${failed} failed`,
  ].join("\n");
}
