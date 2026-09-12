import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  ManifestCommitFailure,
  ManifestCommitIndeterminate,
  ManifestCommittedReleaseFailed,
  ManifestLockCompromised,
  ManifestLockTimeout,
  ManifestMalformed,
  makeSessionCatalog,
  nodeStorage,
  type StorageAdapter,
} from "../index.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-catalog-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  return { root, cwd, agentDir, catalog: makeSessionCatalog(agentDir) };
}

function withStorage(overrides: Partial<StorageAdapter>): StorageAdapter {
  return { ...nodeStorage, ...overrides };
}

async function failureOf<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(effect.pipe(Effect.flip));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session catalog storage", () => {
  effectIt.effect("uses the Effect clock for commit timestamps", () =>
    Effect.gen(function* () {
      const { cwd, catalog } = yield* Effect.promise(fixture);
      const instant = Date.parse("2025-03-04T05:06:07.000Z");
      yield* TestClock.adjust(instant);

      const committed = yield* catalog.update(cwd, (current) => current);

      expect(committed.updatedAt).toBe("2025-03-04T05:06:07.000Z");
    }),
  );

  effectIt.effect("releases the workspace lock when an update is interrupted", () =>
    Effect.gen(function* () {
      const { cwd, agentDir } = yield* Effect.promise(fixture);
      let enter: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let released = false;
      const storage = withStorage({
        lock: async () => async () => {
          released = true;
        },
        readdir: async () => {
          enter();
          return new Promise<string[]>(() => {});
        },
      });
      const catalog = makeSessionCatalog(agentDir, storage);
      const fiber = yield* catalog.update(cwd, (current) => current).pipe(Effect.forkChild);
      yield* Effect.promise(() => entered);

      yield* Fiber.interrupt(fiber);

      expect(released).toBe(true);
    }),
  );

  effectIt.effect("does not release the lock while a durable commit is in flight", () =>
    Effect.gen(function* () {
      const { cwd, agentDir } = yield* Effect.promise(fixture);
      let signalSyncStarted: () => void = () => {};
      const syncStarted = new Promise<void>((resolve) => {
        signalSyncStarted = resolve;
      });
      let allowSync: () => void = () => {};
      const syncAllowed = new Promise<void>((resolve) => {
        allowSync = resolve;
      });
      let released = false;
      const storage = withStorage({
        lock: async () => async () => {
          released = true;
        },
        open: async (path, flags, mode) => {
          const handle = await nodeStorage.open(path, flags, mode);
          if (!path.endsWith(".tmp")) return handle;
          return {
            writeFile: (data) => handle.writeFile(data),
            sync: async () => {
              await handle.sync();
              signalSyncStarted();
              await syncAllowed;
            },
            close: () => handle.close(),
          };
        },
      });
      const catalog = makeSessionCatalog(agentDir, storage);
      const updateFiber = yield* catalog.update(cwd, (current) => current).pipe(Effect.forkChild);
      yield* Effect.promise(() => syncStarted);
      const interruptFiber = yield* Fiber.interrupt(updateFiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(released).toBe(false);
      allowSync();
      yield* Fiber.join(interruptFiber);
      expect(released).toBe(true);
    }),
  );

  it("uses one realpath identity and writes a durable revision with private permissions", async () => {
    const { root, cwd, catalog } = await fixture();
    const alias = join(root, "alias");
    await symlink(cwd, alias);

    const identity = await Effect.runPromise(catalog.identity(cwd));
    const aliasIdentity = await Effect.runPromise(catalog.identity(alias));
    expect(aliasIdentity).toEqual(identity);
    expect(basename(identity.manifestPath)).toMatch(/^[0-9a-f]{64}\.json$/);

    const committed = await Effect.runPromise(catalog.update(cwd, (current) => current));
    const bytes = await readFile(identity.manifestPath, "utf8");
    const mode = (await lstat(identity.manifestPath)).mode & 0o777;

    expect(committed.revision).toBe(1);
    expect(bytes.endsWith("\n")).toBe(true);
    expect(mode).toBe(0o600);
    expect(await Effect.runPromise(catalog.read(alias))).toEqual(committed);
  });

  it("preserves an invalid manifest byte-for-byte on read and update", async () => {
    const { cwd, catalog } = await fixture();
    const identity = await Effect.runPromise(catalog.identity(cwd));
    const invalid = '{"version":1,"corrupt":true}\n';
    await mkdir(dirname(identity.manifestPath), { recursive: true });
    await writeFile(identity.manifestPath, invalid, { mode: 0o600 });
    const digest = basename(identity.manifestPath, ".json");
    const oldTemp = join(
      dirname(identity.manifestPath),
      `.session-catalog-${digest}-${"d".repeat(32)}.tmp`,
    );
    await writeFile(oldTemp, "orphan");
    const old = new Date(Date.now() - 31_000);
    await utimes(oldTemp, old, old);

    expect(await failureOf(catalog.read(cwd))).toBeInstanceOf(ManifestMalformed);
    expect(await readFile(identity.manifestPath, "utf8")).toBe(invalid);
    expect(await failureOf(catalog.update(cwd, (current) => current))).toBeInstanceOf(
      ManifestMalformed,
    );
    expect(await readFile(identity.manifestPath, "utf8")).toBe(invalid);
    expect(await readFile(oldTemp, "utf8")).toBe("orphan");
  });

  it("does not persist mutations from a rejected transform", async () => {
    const { cwd, catalog } = await fixture();
    await Effect.runPromise(catalog.update(cwd, (current) => current));

    await failureOf(
      catalog.update(cwd, (current) => {
        (current as { revision: number }).revision = 999;
        throw new Error("reject transition");
      }),
    );

    expect((await Effect.runPromise(catalog.read(cwd)))?.revision).toBe(1);
  });

  it("serializes concurrent updates without losing revisions", async () => {
    const { cwd, catalog } = await fixture();

    await Promise.all(
      Array.from({ length: 8 }, () => Effect.runPromise(catalog.update(cwd, (current) => current))),
    );

    expect((await Effect.runPromise(catalog.read(cwd)))?.revision).toBe(8);
  });

  it("returns the typed timeout when another process owns the manifest lock", async () => {
    const { cwd, catalog } = await fixture();
    const identity = await Effect.runPromise(catalog.identity(cwd));
    await mkdir(dirname(identity.manifestPath), { recursive: true });
    const release = await lockfile.lock(identity.manifestPath, { realpath: false, retries: 0 });

    try {
      expect(await failureOf(catalog.read(cwd))).toBeInstanceOf(ManifestLockTimeout);
    } finally {
      await release();
    }
  }, 10_000);

  it("removes only old regular temporary files for the locked manifest", async () => {
    const first = await fixture();
    const second = await fixture();
    const firstIdentity = await Effect.runPromise(first.catalog.identity(first.cwd));
    const secondIdentity = await Effect.runPromise(second.catalog.identity(second.cwd));
    const directory = dirname(firstIdentity.manifestPath);
    await mkdir(directory, { recursive: true });

    const digest = basename(firstIdentity.manifestPath, ".json");
    const oldTemp = join(directory, `.session-catalog-${digest}-${"a".repeat(32)}.tmp`);
    const linkedTemp = join(directory, `.session-catalog-${digest}-${"b".repeat(32)}.tmp`);
    const otherDigest = basename(secondIdentity.manifestPath, ".json");
    const otherTemp = join(directory, `.session-catalog-${otherDigest}-${"c".repeat(32)}.tmp`);
    const target = join(directory, "target");
    await writeFile(oldTemp, "old");
    await writeFile(target, "target");
    await symlink(target, linkedTemp);
    await writeFile(otherTemp, "other");
    const old = new Date(Date.now() - 31_000);
    await utimes(oldTemp, old, old);
    await utimes(otherTemp, old, old);

    await Effect.runPromise(first.catalog.update(first.cwd, (current) => current));

    await expect(lstat(oldTemp)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(linkedTemp)).isSymbolicLink()).toBe(true);
    expect((await lstat(otherTemp)).isFile()).toBe(true);
  });

  it("stops a compromised writer before it can rename the manifest", async () => {
    const { cwd, agentDir } = await fixture();
    let compromise: ((cause: unknown) => void) | undefined;
    const storage = withStorage({
      lock: async (path, onCompromised) => {
        compromise = onCompromised;
        return nodeStorage.lock(path, onCompromised);
      },
      open: async (path, flags, mode) => {
        const handle = await nodeStorage.open(path, flags, mode);
        if (!path.endsWith(".tmp")) return handle;
        return {
          writeFile: (data) => handle.writeFile(data),
          sync: async () => {
            await handle.sync();
            compromise?.(new Error("lock ownership lost"));
          },
          close: () => handle.close(),
        };
      },
    });
    const catalog = makeSessionCatalog(agentDir, storage);

    expect(await failureOf(catalog.update(cwd, (current) => current))).toBeInstanceOf(
      ManifestLockCompromised,
    );
    const identity = await Effect.runPromise(catalog.identity(cwd));
    await expect(readFile(identity.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports release failure after a verified commit as already committed", async () => {
    const { cwd, agentDir } = await fixture();
    const storage = withStorage({
      lock: async (path, onCompromised) => {
        const release = await nodeStorage.lock(path, onCompromised);
        return async () => {
          await release();
          throw new Error("release reporting failed");
        };
      },
    });
    const catalog = makeSessionCatalog(agentDir, storage);

    expect(await failureOf(catalog.update(cwd, (current) => current))).toBeInstanceOf(
      ManifestCommittedReleaseFailed,
    );
    expect((await Effect.runPromise(makeSessionCatalog(agentDir).read(cwd)))?.revision).toBe(1);
  });

  it("classifies failures before rename as determinate", async () => {
    const { cwd, agentDir } = await fixture();
    const catalog = makeSessionCatalog(
      agentDir,
      withStorage({ rename: async () => Promise.reject(new Error("rename failed")) }),
    );

    expect(await failureOf(catalog.update(cwd, (current) => current))).toBeInstanceOf(
      ManifestCommitFailure,
    );
    const identity = await Effect.runPromise(catalog.identity(cwd));
    await expect(readFile(identity.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies directory flush failures after rename as indeterminate without rollback", async () => {
    const { cwd, agentDir } = await fixture();
    const normal = makeSessionCatalog(agentDir);
    await Effect.runPromise(normal.update(cwd, (current) => current));
    const identity = await Effect.runPromise(normal.identity(cwd));
    const storage = withStorage({
      open: async (path, flags, mode) => {
        const handle = await nodeStorage.open(path, flags, mode);
        if (path !== dirname(identity.manifestPath)) return handle;
        return {
          writeFile: (data) => handle.writeFile(data),
          sync: async () => Promise.reject(new Error("directory sync failed")),
          close: () => handle.close(),
        };
      },
    });
    const catalog = makeSessionCatalog(agentDir, storage);

    expect(await failureOf(catalog.update(cwd, (current) => current))).toBeInstanceOf(
      ManifestCommitIndeterminate,
    );
    expect((await Effect.runPromise(normal.read(cwd)))?.revision).toBe(2);
  });

  it("classifies a failed post-commit reread as indeterminate", async () => {
    const { cwd, agentDir } = await fixture();
    let renamed = false;
    const storage = withStorage({
      rename: async (from, to) => {
        await nodeStorage.rename(from, to);
        renamed = true;
      },
      readFile: async (path) => {
        if (renamed) throw new Error("verification read failed");
        return nodeStorage.readFile(path);
      },
    });
    const catalog = makeSessionCatalog(agentDir, storage);

    expect(await failureOf(catalog.update(cwd, (current) => current))).toBeInstanceOf(
      ManifestCommitIndeterminate,
    );
    expect((await Effect.runPromise(makeSessionCatalog(agentDir).read(cwd)))?.revision).toBe(1);
  });
});
