import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { LinearErrorCode, LinearExtensionError, linearError } from "./domain";

export interface LinearAppConfig {
  clientId: string;
  callbackPort: number;
  createdAt: string;
}

export interface LinearConnectionConfig {
  id: string;
  name: string;
  appClientId: string;
  organization: { id: string; name: string; urlKey: string };
  viewer: { id: string; name: string; displayName: string; email: string };
  grantedScopes: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface LinearConfigDocument {
  version: 1;
  apps: Record<string, LinearAppConfig>;
  connections: Record<string, LinearConnectionConfig>;
  defaultConnection?: string;
}

export interface LinearGrant {
  connectionId: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string;
}

export interface LinearGrantsDocument {
  version: 1;
  grants: Record<string, LinearGrant>;
}

const AppSchema = Schema.Struct({
  clientId: Schema.String,
  callbackPort: Schema.Number,
  createdAt: Schema.String,
});
const ConnectionSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  appClientId: Schema.String,
  organization: Schema.Struct({ id: Schema.String, name: Schema.String, urlKey: Schema.String }),
  viewer: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    displayName: Schema.String,
    email: Schema.String,
  }),
  grantedScopes: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const ConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  apps: Schema.Record(Schema.String, AppSchema),
  connections: Schema.Record(Schema.String, ConnectionSchema),
  defaultConnection: Schema.optionalKey(Schema.String),
});
const GrantSchema = Schema.Struct({
  connectionId: Schema.String,
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  tokenType: Schema.String,
  scope: Schema.String,
});
const GrantsSchema = Schema.Struct({
  version: Schema.Literal(1),
  grants: Schema.Record(Schema.String, GrantSchema),
});

const emptyConfig = (): LinearConfigDocument => ({ version: 1, apps: {}, connections: {} });
const emptyGrants = (): LinearGrantsDocument => ({ version: 1, grants: {} });

class AtomicJsonStore<T extends object> {
  constructor(
    readonly path: string,
    readonly schema: Schema.ConstraintDecoder<T>,
    readonly empty: () => T,
  ) {}

  async read(): Promise<T> {
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw linearError(LinearErrorCode.Storage, `${this.path} must be a regular file.`);
      }
      if (process.getuid && metadata.uid !== process.getuid()) {
        throw linearError(
          LinearErrorCode.Storage,
          `${this.path} must be owned by the current user.`,
        );
      }
      if ((metadata.mode & 0o077) !== 0) await chmod(this.path, 0o600);
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return Schema.decodeUnknownSync(this.schema)(parsed) as T;
    } catch (cause) {
      if (isMissingFileError(cause)) return this.empty();
      if (cause instanceof LinearExtensionError) throw cause;
      throw linearError(LinearErrorCode.Storage, `${this.path} is invalid or unreadable.`, {
        cause,
      });
    }
  }

  update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return withPathLock(this.path, async () => {
      const next = await mutator(await this.read());
      await this.#write(next);
      return next;
    });
  }

  async #write(value: T): Promise<void> {
    const directory = dirname(this.path);
    const temporaryDirectory = join(directory, `.write-${process.pid}-${randomUUID()}`);
    const temporaryPath = join(temporaryDirectory, "credentials.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await mkdir(temporaryDirectory, { mode: 0o700 });
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
      await syncFile(this.path);
      await rm(temporaryDirectory, { recursive: true, force: true });
      await syncDirectory(directory);
    } catch (cause) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw linearError(LinearErrorCode.Storage, `Cannot save ${this.path}.`, { cause });
    }
  }
}

export interface LinearConfigStore {
  read(): Promise<LinearConfigDocument>;
  saveApp(app: LinearAppConfig): Promise<LinearConfigDocument>;
  saveConnection(connection: LinearConnectionConfig): Promise<LinearConfigDocument>;
  restoreConnection(
    connectionId: string,
    connection: LinearConnectionConfig | undefined,
    defaultConnection: string | undefined,
  ): Promise<LinearConfigDocument>;
  removeConnection(connectionId: string): Promise<LinearConfigDocument>;
  setDefaultConnection(connectionId: string): Promise<LinearConfigDocument>;
}

export interface LinearGrantStore {
  read(): Promise<LinearGrantsDocument>;
  put(grant: LinearGrant): Promise<LinearGrantsDocument>;
  remove(connectionId: string): Promise<LinearGrantsDocument>;
  clear(): Promise<LinearGrantsDocument>;
}

export class LinearConfigRepository implements LinearConfigStore {
  readonly #store: AtomicJsonStore<LinearConfigDocument>;

  constructor(path = join(getAgentDir(), "linear", "config.json")) {
    this.#store = new AtomicJsonStore(path, ConfigSchema, emptyConfig);
  }

  read(): Promise<LinearConfigDocument> {
    return this.#store.read();
  }

  saveApp(app: LinearAppConfig): Promise<LinearConfigDocument> {
    return this.#store.update((current) => ({
      ...current,
      apps: { ...current.apps, [app.clientId]: app },
    }));
  }

  saveConnection(connection: LinearConnectionConfig): Promise<LinearConfigDocument> {
    return this.#store.update((current) => ({
      ...current,
      connections: { ...current.connections, [connection.id]: connection },
      ...(current.defaultConnection ? {} : { defaultConnection: connection.id }),
    }));
  }

  restoreConnection(
    connectionId: string,
    connection: LinearConnectionConfig | undefined,
    defaultConnection: string | undefined,
  ): Promise<LinearConfigDocument> {
    return this.#store.update((current) => {
      const connections = { ...current.connections };
      if (connection) connections[connectionId] = connection;
      else delete connections[connectionId];
      if (defaultConnection) return { ...current, connections, defaultConnection };
      const { defaultConnection: _removed, ...withoutDefault } = current;
      return { ...withoutDefault, connections };
    });
  }

  removeConnection(connectionId: string): Promise<LinearConfigDocument> {
    return this.#store.update((current) => {
      const connections = { ...current.connections };
      delete connections[connectionId];
      if (current.defaultConnection === connectionId) {
        const { defaultConnection: _removed, ...withoutDefault } = current;
        return { ...withoutDefault, connections };
      }
      return { ...current, connections };
    });
  }

  setDefaultConnection(connectionId: string): Promise<LinearConfigDocument> {
    return this.#store.update((current) => {
      if (!current.connections[connectionId]) {
        throw linearError(
          LinearErrorCode.ConnectionNotFound,
          `Unknown Linear connection: ${connectionId}.`,
        );
      }
      return { ...current, defaultConnection: connectionId };
    });
  }
}

export class LinearGrantRepository implements LinearGrantStore {
  readonly #store: AtomicJsonStore<LinearGrantsDocument>;

  constructor(path = join(getAgentDir(), "linear", "credentials.json")) {
    this.#store = new AtomicJsonStore(path, GrantsSchema, emptyGrants);
  }

  read(): Promise<LinearGrantsDocument> {
    return this.#store.read();
  }

  put(grant: LinearGrant): Promise<LinearGrantsDocument> {
    return this.#store.update((current) => ({
      ...current,
      grants: { ...current.grants, [grant.connectionId]: grant },
    }));
  }

  remove(connectionId: string): Promise<LinearGrantsDocument> {
    return this.#store.update((current) => {
      const grants = { ...current.grants };
      delete grants[connectionId];
      return { ...current, grants };
    });
  }

  clear(): Promise<LinearGrantsDocument> {
    return this.#store.update(() => emptyGrants());
  }
}

type LockRegistry = Map<string, Promise<void>>;

function pathLockRegistry(): LockRegistry {
  const globals = globalThis as typeof globalThis & { __piEnvLinearPathLocks?: LockRegistry };
  return (globals.__piEnvLinearPathLocks ??= new Map());
}

async function withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const registry = pathLockRegistry();
  const previous = registry.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.set(path, current);
  await previous;
  try {
    return await withProcessLock(path, operation);
  } finally {
    release();
    if (registry.get(path) === current) registry.delete(path);
  }
}

async function withProcessLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${owner}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (cause) {
      if (!isExistingFileError(cause)) throw cause;
      if (Date.now() >= deadline) {
        const stale = await isStaleLock(lockPath);
        throw linearError(
          LinearErrorCode.Storage,
          stale ? `Stale Linear storage lock: ${lockPath}.` : `Timed out waiting for ${lockPath}.`,
          {
            retryable: !stale,
            recovery: stale
              ? "Confirm that no Pi process uses Linear, then remove the stale lock file."
              : "Retry after the other Pi process finishes its Linear update.",
          },
        );
      }
      await delay(25);
    }
  }
  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockPath, owner);
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(lockPath);
    const raw = await readFile(lockPath, "utf8");
    const pid = Number(raw.trim().split(":", 1)[0]);
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - metadata.mtimeMs > 30_000;
    try {
      process.kill(pid, 0);
      return false;
    } catch (cause) {
      return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
    }
  } catch (cause) {
    return isMissingFileError(cause);
  }
}

async function releaseOwnedLock(lockPath: string, owner: string): Promise<void> {
  let currentOwner: string;
  try {
    currentOwner = (await readFile(lockPath, "utf8")).trim();
  } catch (cause) {
    if (isMissingFileError(cause)) return;
    throw cause;
  }
  if (currentOwner !== owner) return;
  const releasedPath = `${lockPath}.released-${randomUUID()}`;
  try {
    await rename(lockPath, releasedPath);
  } catch (cause) {
    if (isMissingFileError(cause)) return;
    throw cause;
  }
  if ((await readFile(releasedPath, "utf8")).trim() === owner) {
    await rm(releasedPath, { force: true });
  }
}

function isMissingFileError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function isExistingFileError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
