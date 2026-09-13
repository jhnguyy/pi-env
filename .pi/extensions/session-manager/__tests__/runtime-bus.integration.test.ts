import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  RuntimeBusFailure,
  RuntimeMethod,
  resolveRuntimePaths,
  runtimeRequest,
  startRuntimeBus,
} from "../index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-runtime-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(cwd)]);
  const paths = await Effect.runPromise(resolveRuntimePaths(cwd, { XDG_RUNTIME_DIR: runtime }));
  const publications: unknown[] = [];
  const calls = { reconcile: 0 };
  const server = await Effect.runPromise(
    startRuntimeBus({
      paths,
      workspaceId: "a".repeat(64),
      coordinatorSessionId: "coordinator-a",
      handlers: {
        reconcile: async () => {
          calls.reconcile += 1;
          return { outcomes: [] };
        },
        publishReady: async (publication) => {
          publications.push(publication);
        },
      },
    }),
  );
  return { paths, server, publications, calls };
}

async function failureOf<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(effect.pipe(Effect.flip));
}

describe("session runtime bus", () => {
  it("serves correlated ping, reconcile, and idempotent readiness on a private socket", async () => {
    const { paths, server, publications, calls } = await fixture();
    try {
      expect((await lstat(paths.socketPath)).mode & 0o777).toBe(0o600);
      const identity = {
        socketPath: paths.socketPath,
        workspaceId: "a".repeat(64),
        coordinatorSessionId: "coordinator-a",
      };
      await expect(
        Effect.runPromise(
          runtimeRequest<{ alive: boolean }>({
            ...identity,
            method: RuntimeMethod.Ping,
            timeoutMs: 2_000,
          }),
        ),
      ).resolves.toEqual({ alive: true });
      await expect(
        Promise.all([
          Effect.runPromise(
            runtimeRequest({
              ...identity,
              method: RuntimeMethod.Reconcile,
              idempotencyKey: "restore-a",
              timeoutMs: 2_000,
            }),
          ),
          Effect.runPromise(
            runtimeRequest({
              ...identity,
              method: RuntimeMethod.Reconcile,
              idempotencyKey: "restore-a",
              timeoutMs: 2_000,
            }),
          ),
        ]),
      ).resolves.toEqual([{ outcomes: [] }, { outcomes: [] }]);
      expect(calls.reconcile).toBe(1);
      const ready = {
        sessionId: "work-a",
        runtimeId: "runtime-a",
        launchId: "launch-a",
        windowId: "@2",
      };
      await Effect.runPromise(
        runtimeRequest({
          ...identity,
          method: RuntimeMethod.PublishReady,
          idempotencyKey: "ready-a",
          params: ready,
          timeoutMs: 2_000,
        }),
      );
      await Effect.runPromise(
        runtimeRequest({
          ...identity,
          method: RuntimeMethod.PublishReady,
          idempotencyKey: "ready-a",
          params: ready,
          timeoutMs: 2_000,
        }),
      );
      expect(publications).toEqual([ready]);
    } finally {
      await server.close();
    }
  });

  it("rejects a mismatched workspace and an oversized incomplete frame", async () => {
    const { paths, server } = await fixture();
    try {
      expect(
        await failureOf(
          runtimeRequest({
            socketPath: paths.socketPath,
            workspaceId: "b".repeat(64),
            coordinatorSessionId: "coordinator-a",
            method: RuntimeMethod.Ping,
            timeoutMs: 2_000,
          }),
        ),
      ).toBeInstanceOf(RuntimeBusFailure);

      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(paths.socketPath);
        let received = "";
        socket.setEncoding("utf8");
        socket.once("connect", () => socket.write("x".repeat(65_538)));
        socket.on("data", (chunk) => (received += chunk));
        socket.once("end", () => resolve(received));
        socket.once("error", reject);
      });
      expect(JSON.parse(response.trim())).toMatchObject({
        ok: false,
        error: { code: "FrameTooLarge" },
      });
    } finally {
      await server.close();
    }
  });

  it("removes the socket when metadata publication fails after bind", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-runtime-cleanup-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(cwd)]);
    const paths = await Effect.runPromise(resolveRuntimePaths(cwd, { XDG_RUNTIME_DIR: runtime }));
    await mkdir(paths.metadataPath);

    expect(
      await failureOf(
        startRuntimeBus({
          paths,
          workspaceId: "a".repeat(64),
          coordinatorSessionId: "coordinator-a",
          handlers: { reconcile: async () => ({ outcomes: [] }), publishReady: async () => {} },
        }),
      ),
    ).toBeInstanceOf(RuntimeBusFailure);
    await expect(lstat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("secures a runtime directory that was initially accessible to other users", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-runtime-mode-"));
    roots.push(root);
    await chmod(root, 0o755);
    const cwd = join(root, "workspace");
    await mkdir(cwd);

    const paths = await Effect.runPromise(resolveRuntimePaths(cwd, { XDG_RUNTIME_DIR: root }));

    expect((await lstat(paths.directory)).mode & 0o777).toBe(0o700);
  });
});
