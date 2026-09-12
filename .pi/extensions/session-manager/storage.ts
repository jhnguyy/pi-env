import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, readdir, rename, lstat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Clock, Context, Effect, Layer } from "effect";
import lockfile from "proper-lockfile";
import {
  ManifestCommitFailure,
  ManifestCommitIndeterminate,
  ManifestCommittedReleaseFailed,
  ManifestLockCompromised,
  ManifestLockTimeout,
  ManifestMalformed,
  ManifestOperationFailure,
  ManifestReadFailure,
  ManifestSemanticFailure,
  ManifestUnsupportedVersion,
  type ManifestIdentity,
  type SessionCatalogFailure,
  type SessionManifest,
} from "./contracts.js";
import { canonicalJson, validateManifest } from "./schema.js";

const STALE = 30_000;
export interface StorageAdapter {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly lstat: (path: string) => Promise<{ isFile(): boolean; mtimeMs: number }>;
  readonly unlink: (path: string) => Promise<void>;
  readonly open: (
    path: string,
    flags: string,
    mode?: number,
  ) => Promise<{
    writeFile(data: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly lock: (
    path: string,
    compromised: (cause: unknown) => void,
  ) => Promise<() => Promise<void>>;
}
export const nodeStorage: StorageAdapter = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readFile: (path) => readFile(path, "utf8"),
  readdir,
  lstat,
  unlink,
  open: (p, f, m) => open(p, f, m),
  rename,
  lock: (path, compromised) =>
    lockfile.lock(path, {
      realpath: false,
      stale: STALE,
      update: 10_000,
      retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: false },
      onCompromised: compromised,
    }),
};
const errno = (x: unknown, code: string) =>
  typeof x === "object" && x !== null && (x as NodeJS.ErrnoException).code === code;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function manifestPathForCanonicalCwd(agentDir: string, canonicalCwd: string): string {
  const digest = createHash("sha256").update(canonicalCwd, "utf8").digest("hex");
  return join(agentDir, "session-manager", "workspaces", `${digest}.json`);
}

class FileSessionCatalog {
  constructor(
    readonly agentDir: string,
    readonly storage: StorageAdapter = nodeStorage,
  ) {}
  identity(cwd: string): Effect.Effect<ManifestIdentity, ManifestReadFailure> {
    return Effect.tryPromise({
      try: async () => {
        const canonicalCwd = await realpath(cwd);
        return {
          canonicalCwd,
          manifestPath: manifestPathForCanonicalCwd(this.agentDir, canonicalCwd),
        };
      },
      catch: (cause) => new ManifestReadFailure({ path: cwd, cause }),
    });
  }
  read(cwd: string): Effect.Effect<SessionManifest | null, SessionCatalogFailure> {
    return Effect.flatMap(this.identity(cwd), (identity) =>
      this.withLock(
        identity.manifestPath,
        () =>
          Effect.tryPromise({
            try: () => this.readUnlocked(identity.manifestPath, identity.canonicalCwd),
            catch: (error) => this.failure(identity.manifestPath, error),
          }),
        false,
      ),
    );
  }

  update(
    cwd: string,
    transform: (current: SessionManifest) => SessionManifest,
  ): Effect.Effect<SessionManifest, SessionCatalogFailure> {
    const catalog = this;
    return Effect.flatMap(this.identity(cwd), (identity) =>
      this.withLock(
        identity.manifestPath,
        (assertOwned) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const current = yield* Effect.tryPromise({
              try: () => catalog.readUnlocked(identity.manifestPath, identity.canonicalCwd),
              catch: (error) => catalog.failure(identity.manifestPath, error),
            });
            yield* Effect.tryPromise({
              try: () => catalog.cleanTemps(identity.manifestPath, now),
              catch: (error) => catalog.failure(identity.manifestPath, error),
            });
            const empty: SessionManifest = {
              version: 1,
              canonicalCwd: identity.canonicalCwd,
              revision: 0,
              updatedAt: new Date(now).toISOString(),
              sessions: [],
            };
            const next = yield* Effect.try({
              try: () => {
                const draft = transform(clone(current ?? empty));
                return validateManifest(
                  {
                    ...draft,
                    version: 1,
                    canonicalCwd: identity.canonicalCwd,
                    revision: (current?.revision ?? 0) + 1,
                    updatedAt: new Date(now).toISOString(),
                  },
                  identity.manifestPath,
                );
              },
              catch: (error) => catalog.failure(identity.manifestPath, error),
            });
            yield* Effect.tryPromise({
              try: () => catalog.commit(identity.manifestPath, next, assertOwned),
              catch: (error) => catalog.failure(identity.manifestPath, error),
            }).pipe(Effect.uninterruptible);
            return next;
          }),
        true,
      ),
    );
  }

  private failure(path: string, error: unknown): SessionCatalogFailure {
    if (
      error instanceof ManifestMalformed ||
      error instanceof ManifestUnsupportedVersion ||
      error instanceof ManifestSemanticFailure ||
      error instanceof ManifestReadFailure ||
      error instanceof ManifestCommitFailure ||
      error instanceof ManifestCommitIndeterminate ||
      error instanceof ManifestCommittedReleaseFailed ||
      error instanceof ManifestLockCompromised ||
      error instanceof ManifestLockTimeout ||
      error instanceof ManifestOperationFailure
    ) {
      return error;
    }
    return new ManifestOperationFailure({ path, cause: error });
  }

  private withLock<A, E, R>(
    path: string,
    operation: (assertOwned: () => void) => Effect.Effect<A, E, R>,
    commits: boolean,
  ): Effect.Effect<
    A,
    | E
    | ManifestLockTimeout
    | ManifestLockCompromised
    | ManifestOperationFailure
    | ManifestCommittedReleaseFailed,
    R
  > {
    const storage = this.storage;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => storage.mkdir(dirname(path)),
          catch: (cause) => new ManifestOperationFailure({ path, cause }),
        });
        let compromised: unknown;
        const release = yield* Effect.tryPromise({
          try: () =>
            storage.lock(path, (cause) => {
              compromised = cause;
            }),
          catch: (cause) =>
            errno(cause, "ELOCKED")
              ? new ManifestLockTimeout({ path, cause })
              : new ManifestOperationFailure({ path, cause }),
        });
        const assertOwned = () => {
          if (compromised !== undefined) {
            throw new ManifestLockCompromised({ path, cause: compromised });
          }
        };
        const operationExit = yield* Effect.exit(
          restore(
            Effect.suspend(() => {
              assertOwned();
              return operation(assertOwned);
            }),
          ),
        );
        const releaseExit = yield* Effect.exit(
          Effect.tryPromise({
            try: () => release(),
            catch: (cause) => new ManifestOperationFailure({ path, cause }),
          }),
        );

        if (operationExit._tag === "Failure") {
          return yield* Effect.failCause(operationExit.cause);
        }
        const value = operationExit.value;
        if (compromised !== undefined) {
          if (commits) {
            return yield* new ManifestCommittedReleaseFailed({
              path,
              revision: (value as SessionManifest).revision,
              cause: compromised,
            });
          }
          return yield* new ManifestLockCompromised({ path, cause: compromised });
        }
        if (releaseExit._tag === "Failure") {
          if (commits) {
            return yield* new ManifestCommittedReleaseFailed({
              path,
              revision: (value as SessionManifest).revision,
              cause: releaseExit.cause,
            });
          }
          return yield* new ManifestOperationFailure({ path, cause: releaseExit.cause });
        }
        return value;
      }),
    );
  }
  private async readUnlocked(path: string, cwd: string): Promise<SessionManifest | null> {
    let text: string;
    try {
      text = await this.storage.readFile(path);
    } catch (cause) {
      if (errno(cause, "ENOENT")) return null;
      throw new ManifestReadFailure({ path, cause });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ManifestMalformed({ path, reason: "invalid JSON" });
    }
    const m = validateManifest(value, path);
    if (m.canonicalCwd !== cwd)
      throw new ManifestMalformed({ path, reason: "workspace identity mismatch" });
    return m;
  }
  private temp(path: string) {
    return join(
      dirname(path),
      `.session-catalog-${basename(path, ".json")}-${randomBytes(16).toString("hex")}.tmp`,
    );
  }
  private async cleanTemps(path: string, now: number) {
    const prefix = `.session-catalog-${basename(path, ".json")}-`;
    for (const name of await this.storage.readdir(dirname(path))) {
      if (!name.startsWith(prefix) || !/^[a-z0-9.-]+-[0-9a-f]{32}\.tmp$/.test(name)) continue;
      const candidate = join(dirname(path), name);
      try {
        const info = await this.storage.lstat(candidate);
        if (info.isFile() && now - info.mtimeMs > STALE) await this.storage.unlink(candidate);
      } catch (e) {
        if (!errno(e, "ENOENT")) throw e;
      }
    }
  }
  private async commit(path: string, manifest: SessionManifest, assertOwned: () => void) {
    const tmp = this.temp(path);
    let renamed = false;
    try {
      assertOwned();
      const file = await this.storage.open(tmp, "wx", 0o600);
      try {
        await file.writeFile(`${canonicalJson(manifest)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      assertOwned();
      await this.storage.rename(tmp, path);
      renamed = true;
      assertOwned();
      const directory = await this.storage.open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      assertOwned();
      const found = await this.readUnlocked(path, manifest.canonicalCwd);
      assertOwned();
      if (!found || found.revision !== manifest.revision) throw new Error("verification failed");
    } catch (cause) {
      if (!renamed && cause instanceof ManifestLockCompromised) throw cause;
      if (renamed)
        throw new ManifestCommitIndeterminate({ path, revision: manifest.revision, cause });
      try {
        await this.storage.unlink(tmp);
      } catch {
        /* recognized orphan is safe for later GC */
      }
      throw new ManifestCommitFailure({ path, cause });
    }
  }
}

export interface SessionCatalogShape {
  readonly identity: (cwd: string) => Effect.Effect<ManifestIdentity, ManifestReadFailure>;
  readonly read: (cwd: string) => Effect.Effect<SessionManifest | null, SessionCatalogFailure>;
  readonly update: (
    cwd: string,
    transform: (current: SessionManifest) => SessionManifest,
  ) => Effect.Effect<SessionManifest, SessionCatalogFailure>;
}

export class SessionCatalog extends Context.Service<SessionCatalog, SessionCatalogShape>()(
  "pi/session-manager/SessionCatalog",
) {}

export function makeSessionCatalog(
  agentDir: string,
  storage: StorageAdapter = nodeStorage,
): SessionCatalogShape {
  return new FileSessionCatalog(agentDir, storage);
}

export function sessionCatalogLayer(
  agentDir: string,
  storage: StorageAdapter = nodeStorage,
): Layer.Layer<SessionCatalog> {
  return Layer.succeed(SessionCatalog, makeSessionCatalog(agentDir, storage));
}
