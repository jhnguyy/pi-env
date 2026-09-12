import { Clock, Data, Effect } from "effect";
import {
  ManifestOperationFailure,
  type OpenSessionRecord,
  type Persistence,
  type SessionCatalogFailure,
  type SessionManifest,
} from "./contracts.js";
import {
  type CloseSource,
  findRecord,
  nameCandidates,
  replaceWorkRecord,
  selectAvailableName,
  type NameEntropy,
} from "./domain.js";
import type { SessionHostError, SessionHostShape } from "./host.js";
import type { SessionFileError, SessionFileProbe } from "./session-file.js";
import type { SessionCatalogShape } from "./storage.js";

export class SessionNotManaged extends Data.TaggedError("SessionNotManaged")<{
  sessionId: string;
}> {}
export class SessionAlreadyClosed extends Data.TaggedError("SessionAlreadyClosed")<{
  sessionId: string;
}> {}
export class SessionIdentityConflict extends Data.TaggedError("SessionIdentityConflict")<{
  sessionId: string;
  reason: string;
}> {}
export class SessionNameConflict extends Data.TaggedError("SessionNameConflict")<{
  name: string;
}> {}
export class SessionNameUnavailable extends Data.TaggedError("SessionNameUnavailable")<{}> {}
export class SessionBindingFailed extends Data.TaggedError("SessionBindingFailed")<{
  session: ManagedSession;
  cause: SessionHostError;
}> {}
export class SessionWindowSyncFailed extends Data.TaggedError("SessionWindowSyncFailed")<{
  session: ManagedSession;
  cause: SessionHostError;
}> {}
export type SessionLifecycleDomainError =
  | SessionNotManaged
  | SessionAlreadyClosed
  | SessionIdentityConflict
  | SessionNameConflict
  | SessionNameUnavailable;
export type SessionLifecycleError =
  | SessionLifecycleDomainError
  | SessionCatalogFailure
  | SessionHostError
  | SessionFileError
  | SessionBindingFailed
  | SessionWindowSyncFailed;

export type SessionStartInput = {
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly cwd: string;
  readonly paneId?: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
};
export type ManagedSession = {
  readonly role: "work";
  readonly record: OpenSessionRecord;
  readonly paneId: string;
};
export type StartResult =
  | { readonly state: "managed"; readonly session: ManagedSession; readonly assignedName: boolean }
  | { readonly state: "unmanaged"; readonly reason: string };

export type SessionStatus = {
  readonly current?: OpenSessionRecord;
  readonly open: number;
  readonly closed: number;
  readonly revision: number;
};

export interface SessionLifecycle {
  readonly start: (input: SessionStartInput) => Effect.Effect<StartResult, SessionLifecycleError>;
  readonly adopt: (input: SessionStartInput) => Effect.Effect<ManagedSession, SessionLifecycleError>;
  readonly close: (
    session: ManagedSession,
    source: CloseSource,
    sessionFile?: string,
  ) => Effect.Effect<void, SessionLifecycleError>;
  readonly rename: (
    session: ManagedSession,
    name: string,
  ) => Effect.Effect<ManagedSession, SessionLifecycleError>;
  readonly refreshMaterialization: (
    session: ManagedSession,
    sessionFile?: string,
  ) => Effect.Effect<ManagedSession, SessionLifecycleError>;
  readonly status: (cwd: string, sessionId: string) => Effect.Effect<SessionStatus, SessionCatalogFailure>;
}

const nowIso = Effect.map(Clock.currentTimeMillis, (value) => new Date(value).toISOString());
const isDomainError = (value: unknown): value is SessionLifecycleDomainError =>
  value instanceof SessionNotManaged ||
  value instanceof SessionAlreadyClosed ||
  value instanceof SessionIdentityConflict ||
  value instanceof SessionNameConflict ||
  value instanceof SessionNameUnavailable;
const unwrapDomain = (error: SessionCatalogFailure): SessionCatalogFailure | SessionLifecycleDomainError =>
  error instanceof ManifestOperationFailure && isDomainError(error.cause) ? error.cause : error;

function persistenceFor(materialized: boolean, sessionFile?: string): Persistence {
  return materialized && sessionFile
    ? { state: "materialized", sessionFile }
    : { state: "pending" };
}

export function createSessionLifecycle(options: {
  readonly catalog: SessionCatalogShape;
  readonly host: SessionHostShape;
  readonly sessionFiles: SessionFileProbe;
  readonly entropy: NameEntropy;
}): SessionLifecycle {
  const { catalog, host, sessionFiles, entropy } = options;

  type Materialization = {
    readonly exists: boolean;
    readonly persistence: Persistence;
  };
  const materialization = (
    input: SessionStartInput,
  ): Effect.Effect<Materialization, SessionFileError> => {
    if (!input.sessionFile) {
      return Effect.succeed<Materialization>({
        exists: false,
        persistence: persistenceFor(false),
      });
    }
    const sessionFile = input.sessionFile;
    return Effect.flatMap(sessionFiles.exists(sessionFile), (exists) => {
      if (!exists) {
        return Effect.succeed<Materialization>({
          exists: false,
          persistence: persistenceFor(false),
        });
      }
      return Effect.as(sessionFiles.verify(sessionFile, input.sessionId, input.cwd), {
        exists: true,
        persistence: persistenceFor(true, sessionFile),
      } satisfies Materialization);
    });
  };

  const start = (input: SessionStartInput): Effect.Effect<StartResult, SessionLifecycleError> =>
    Effect.gen(function* () {
      if (input.mode !== "tui") return { state: "unmanaged", reason: "not interactive" } as const;
      if (!input.paneId) return { state: "unmanaged", reason: "not inside tmux" } as const;
      const identity = yield* catalog.identity(input.cwd);
      const canonicalInput = { ...input, cwd: identity.canonicalCwd };
      const observed = yield* materialization(canonicalInput);
      const current = yield* catalog.read(identity.canonicalCwd);
      const existing = current ? findRecord(current, input.sessionId) : undefined;
      if (existing?.role === "coordinator") {
        return { state: "unmanaged", reason: "coordinator lifecycle is not enabled" } as const;
      }
      if (existing?.role === "work" && existing.desiredState === "closed") {
        return { state: "unmanaged", reason: "session is closed" } as const;
      }
      if (!existing && observed.exists) {
        return { state: "unmanaged", reason: "materialized session requires /session-adopt" } as const;
      }
      const timestamp = yield* nowIso;
      const candidates = nameCandidates(entropy);
      let selected: OpenSessionRecord | undefined;
      const committed = yield* catalog
        .update(identity.canonicalCwd, (manifest) => {
          const found = findRecord(manifest, input.sessionId);
          if (found?.role === "coordinator") {
            throw new SessionIdentityConflict({
              sessionId: input.sessionId,
              reason: "session ID belongs to the coordinator",
            });
          }
          if (found?.role === "work" && found.desiredState === "closed") {
            throw new SessionAlreadyClosed({ sessionId: input.sessionId });
          }
          if (found?.role === "work") {
            selected = {
              ...found,
              persistence:
                observed.persistence.state === "materialized" ? observed.persistence : found.persistence,
              lastOpenedAt: timestamp,
            };
            return replaceWorkRecord(manifest, selected);
          }
          const requestedName = input.sessionName?.trim();
          const name = requestedName || selectAvailableName(manifest, candidates);
          if (!name) throw new SessionNameUnavailable();
          if (
            requestedName &&
            (manifest.coordinator?.name === name ||
              manifest.sessions.some(
                (record) => record.desiredState === "open" && record.name === name,
              ))
          ) {
            throw new SessionNameConflict({ name });
          }
          selected = {
            version: 1,
            sessionId: input.sessionId,
            cwd: identity.canonicalCwd,
            name,
            persistence: observed.persistence,
            createdAt: timestamp,
            lastOpenedAt: timestamp,
            role: "work",
            desiredState: "open",
          };
          return replaceWorkRecord(manifest, selected);
        })
        .pipe(Effect.mapError(unwrapDomain));
      const record = selected ?? (findRecord(committed, input.sessionId) as OpenSessionRecord);
      const session: ManagedSession = { role: "work", record, paneId: input.paneId };
      yield* host
        .bindCurrent(input.paneId, input.sessionId, record.name)
        .pipe(Effect.mapError((cause) => new SessionBindingFailed({ session, cause })));
      return {
        state: "managed",
        session,
        assignedName: !input.sessionName,
      } as const;
    });

  const adopt = (input: SessionStartInput): Effect.Effect<ManagedSession, SessionLifecycleError> =>
    Effect.gen(function* () {
      if (input.mode !== "tui" || !input.paneId || !input.sessionFile) {
        return yield* new SessionIdentityConflict({
          sessionId: input.sessionId,
          reason: "adoption requires a materialized interactive session inside tmux",
        });
      }
      const identity = yield* catalog.identity(input.cwd);
      yield* sessionFiles.verify(input.sessionFile, input.sessionId, identity.canonicalCwd);
      const timestamp = yield* nowIso;
      const candidates = nameCandidates(entropy);
      let selected: OpenSessionRecord | undefined;
      const committed = yield* catalog
        .update(identity.canonicalCwd, (manifest) => {
          const found = findRecord(manifest, input.sessionId);
          if (found?.role === "coordinator") {
            throw new SessionIdentityConflict({
              sessionId: input.sessionId,
              reason: "session ID belongs to the coordinator",
            });
          }
          if (found?.role === "work" && found.desiredState === "closed") {
            throw new SessionAlreadyClosed({ sessionId: input.sessionId });
          }
          const requestedName = input.sessionName?.trim();
          const name = requestedName || found?.name || selectAvailableName(manifest, candidates);
          if (!name) throw new SessionNameUnavailable();
          const collision = manifest.sessions.some(
            (record) =>
              record.sessionId !== input.sessionId &&
              record.desiredState === "open" &&
              record.name === name,
          );
          if (manifest.coordinator?.name === name || collision) throw new SessionNameConflict({ name });
          selected = {
            version: 1,
            sessionId: input.sessionId,
            cwd: identity.canonicalCwd,
            name,
            persistence: { state: "materialized", sessionFile: input.sessionFile! },
            createdAt: found?.createdAt ?? timestamp,
            lastOpenedAt: timestamp,
            role: "work",
            desiredState: "open",
            ...(found?.role === "work" && found.taskRef ? { taskRef: found.taskRef } : {}),
          };
          return replaceWorkRecord(manifest, selected);
        })
        .pipe(Effect.mapError(unwrapDomain));
      const record = selected ?? (findRecord(committed, input.sessionId) as OpenSessionRecord);
      const session: ManagedSession = { role: "work", record, paneId: input.paneId };
      yield* host
        .bindCurrent(input.paneId, input.sessionId, record.name)
        .pipe(Effect.mapError((cause) => new SessionBindingFailed({ session, cause })));
      return session;
    });

  const close = (session: ManagedSession, source: CloseSource, sessionFile?: string) =>
    Effect.gen(function* () {
      let persistence = session.record.persistence;
      if (persistence.state === "pending" && sessionFile) {
        const exists = yield* sessionFiles.exists(sessionFile);
        if (exists) {
          yield* sessionFiles.verify(sessionFile, session.record.sessionId, session.record.cwd);
          persistence = { state: "materialized", sessionFile };
        }
      }
      const timestamp = yield* nowIso;
      yield* catalog
        .update(session.record.cwd, (manifest) => {
          const found = findRecord(manifest, session.record.sessionId);
          if (!found || found.role !== "work") {
            throw new SessionNotManaged({ sessionId: session.record.sessionId });
          }
          if (found.desiredState === "closed") return manifest;
          return replaceWorkRecord(manifest, {
            ...found,
            persistence,
            desiredState: "closed",
            closedAt: timestamp,
            closedBy: source,
          });
        })
        .pipe(Effect.mapError(unwrapDomain));
    });

  const rename = (session: ManagedSession, name: string) =>
    Effect.gen(function* () {
      const normalized = name.trim();
      if (!normalized) return yield* new SessionNameConflict({ name });
      if (normalized === session.record.name) return session;
      let selected: OpenSessionRecord | undefined;
      const committed = yield* catalog
        .update(session.record.cwd, (manifest) => {
          const found = findRecord(manifest, session.record.sessionId);
          if (!found || found.role !== "work" || found.desiredState !== "open") {
            throw new SessionNotManaged({ sessionId: session.record.sessionId });
          }
          const collision =
            manifest.coordinator?.name === normalized ||
            manifest.sessions.some(
              (record) =>
                record.sessionId !== found.sessionId &&
                record.desiredState === "open" &&
                record.name === normalized,
            );
          if (collision) throw new SessionNameConflict({ name: normalized });
          selected = { ...found, name: normalized };
          return replaceWorkRecord(manifest, selected);
        })
        .pipe(Effect.mapError(unwrapDomain));
      const record = selected ?? (findRecord(committed, session.record.sessionId) as OpenSessionRecord);
      const renamed = { ...session, record };
      yield* host
        .renameCurrent(session.paneId, record.sessionId, record.name)
        .pipe(Effect.mapError((cause) => new SessionWindowSyncFailed({ session: renamed, cause })));
      return renamed;
    });

  const refreshMaterialization = (session: ManagedSession, sessionFile?: string) =>
    Effect.gen(function* () {
      if (session.record.persistence.state === "materialized" || !sessionFile) return session;
      const exists = yield* sessionFiles.exists(sessionFile);
      if (!exists) return session;
      yield* sessionFiles.verify(sessionFile, session.record.sessionId, session.record.cwd);
      let selected: OpenSessionRecord | undefined;
      const committed = yield* catalog
        .update(session.record.cwd, (manifest) => {
          const found = findRecord(manifest, session.record.sessionId);
          if (!found || found.role !== "work" || found.desiredState !== "open") {
            throw new SessionNotManaged({ sessionId: session.record.sessionId });
          }
          selected = { ...found, persistence: { state: "materialized", sessionFile } };
          return replaceWorkRecord(manifest, selected);
        })
        .pipe(Effect.mapError(unwrapDomain));
      const record = selected ?? (findRecord(committed, session.record.sessionId) as OpenSessionRecord);
      return { ...session, record };
    });

  const status = (cwd: string, sessionId: string) =>
    Effect.gen(function* () {
      const manifest = yield* catalog.read(cwd);
      if (!manifest) return { open: 0, closed: 0, revision: 0 };
      const found = findRecord(manifest, sessionId);
      const current =
        found?.role === "work" && found.desiredState === "open" ? found : undefined;
      return {
        ...(current ? { current } : {}),
        open: manifest.sessions.filter((record) => record.desiredState === "open").length,
        closed: manifest.sessions.filter((record) => record.desiredState === "closed").length,
        revision: manifest.revision,
      };
    });

  return { start, adopt, close, rename, refreshMaterialization, status };
}
