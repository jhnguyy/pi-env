import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { OpenSessionRecord } from "../contracts.js";
import { createWorkspaceReconciler, ensureCoordinator } from "../coordinator.js";
import { SessionHostFailure, type CurrentWindow, type SessionHostShape } from "../host.js";
import { createFileSessionCatalog } from "../storage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-coordinator-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd, catalog: createFileSessionCatalog(join(root, "agent")) };
}

const window: CurrentWindow = {
  socketPath: "/tmp/tmux.sock",
  tmuxSessionId: "$1",
  windowId: "@1",
  bindings: [],
};

describe("workspace coordinator", () => {
  it("creates one stable durable coordinator", async () => {
    const { cwd, catalog } = await fixture();

    const first = await Effect.runPromise(
      ensureCoordinator({ catalog, cwd, entropy: () => 0 }),
    );
    const second = await Effect.runPromise(
      ensureCoordinator({ catalog, cwd, entropy: () => 99 }),
    );

    expect(first.role).toBe("coordinator");
    expect(second).toEqual(first);
    expect((await Effect.runPromise(catalog.read(cwd)))?.coordinator).toEqual(first);
  });

  it("restores independent sessions and reports one failure without failing the workspace", async () => {
    const { root, cwd, catalog } = await fixture();
    const coordinator = await Effect.runPromise(
      ensureCoordinator({ catalog, cwd, entropy: () => 0 }),
    );
    const timestamp = new Date().toISOString();
    const sessionFile = join(root, "work-a.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "work-a", cwd })}\n`,
    );
    const records: OpenSessionRecord[] = [
      {
        version: 1,
        sessionId: "work-a",
        cwd,
        name: "quiet-pine",
        persistence: { state: "materialized", sessionFile },
        createdAt: timestamp,
        lastOpenedAt: timestamp,
        role: "work",
        desiredState: "open",
      },
      {
        version: 1,
        sessionId: "work-b",
        cwd,
        name: "blue-lake",
        persistence: { state: "pending" },
        createdAt: timestamp,
        lastOpenedAt: timestamp,
        role: "work",
        desiredState: "open",
      },
    ];
    await Effect.runPromise(
      catalog.update(cwd, (manifest) => ({ ...manifest, sessions: records })),
    );
    let reconciler: ReturnType<typeof createWorkspaceReconciler>;
    const host: SessionHostShape = {
      inspectCurrent: () => Effect.succeed(window),
      bindCurrent: () => Effect.succeed(window),
      renameCurrent: () => Effect.void,
      releaseCurrent: () => Effect.void,
      restoreWindow: (input) =>
        input.sessionId === "work-b"
          ? Effect.fail(new SessionHostFailure({ operation: "create", reason: "tmux failed" }))
          : Effect.promise(async () => {
              queueMicrotask(() => {
                void reconciler.publishReady({
                  sessionId: input.sessionId,
                  runtimeId: "runtime-a",
                  launchId: input.launchId,
                  windowId: "@2",
                });
              });
              return { state: "created" as const, windowId: "@2" };
            }),
    };
    reconciler = createWorkspaceReconciler({
      catalog,
      host,
      paneId: "%1",
      cwd,
      workspaceId: "a".repeat(64),
      coordinatorSessionId: coordinator.sessionId,
      wrapperPath: "/bin/pi",
      extensionPath: "/extension.js",
      readyTimeoutMs: 1_000,
    });

    const summary = await reconciler.reconcile();

    expect(summary.outcomes).toEqual([
      { sessionId: "work-a", name: "quiet-pine", state: "restored" },
      { sessionId: "work-b", name: "blue-lake", state: "failed", reason: "SessionHostFailure" },
    ]);
  });

  it("accepts a fresh readiness announcement from a surviving existing window", async () => {
    const { cwd, catalog } = await fixture();
    const coordinator = await Effect.runPromise(
      ensureCoordinator({ catalog, cwd, entropy: () => 0 }),
    );
    const timestamp = new Date().toISOString();
    await Effect.runPromise(
      catalog.update(cwd, (manifest) => ({
        ...manifest,
        sessions: [
          {
            version: 1,
            sessionId: "work-a",
            cwd,
            name: "quiet-pine",
            persistence: { state: "pending" },
            createdAt: timestamp,
            lastOpenedAt: timestamp,
            role: "work",
            desiredState: "open",
          },
        ],
      })),
    );
    let reconciler: ReturnType<typeof createWorkspaceReconciler>;
    const host: SessionHostShape = {
      inspectCurrent: () => Effect.succeed(window),
      bindCurrent: () => Effect.succeed(window),
      renameCurrent: () => Effect.void,
      releaseCurrent: () => Effect.void,
      restoreWindow: () =>
        Effect.sync(() => {
          queueMicrotask(() => {
            void reconciler.publishReady({
              sessionId: "work-a",
              runtimeId: "surviving-runtime",
              launchId: "original-launch",
              windowId: "@2",
            });
          });
          return { state: "existing" as const, windowId: "@2" };
        }),
    };
    reconciler = createWorkspaceReconciler({
      catalog,
      host,
      paneId: "%1",
      cwd,
      workspaceId: "a".repeat(64),
      coordinatorSessionId: coordinator.sessionId,
      wrapperPath: "/bin/pi",
      extensionPath: "/extension.js",
      readyTimeoutMs: 1_000,
    });

    expect(await reconciler.reconcile()).toEqual({
      outcomes: [{ sessionId: "work-a", name: "quiet-pine", state: "active" }],
    });
  });

  it("leaves an unready restored window running and reports its timeout", async () => {
    const { cwd, catalog } = await fixture();
    const coordinator = await Effect.runPromise(
      ensureCoordinator({ catalog, cwd, entropy: () => 0 }),
    );
    const timestamp = new Date().toISOString();
    await Effect.runPromise(
      catalog.update(cwd, (manifest) => ({
        ...manifest,
        sessions: [
          {
            version: 1,
            sessionId: "work-a",
            cwd,
            name: "quiet-pine",
            persistence: { state: "pending" },
            createdAt: timestamp,
            lastOpenedAt: timestamp,
            role: "work",
            desiredState: "open",
          },
        ],
      })),
    );
    let created = 0;
    const reconciler = createWorkspaceReconciler({
      catalog,
      host: {
        inspectCurrent: () => Effect.succeed(window),
        bindCurrent: () => Effect.succeed(window),
        renameCurrent: () => Effect.void,
        releaseCurrent: () => Effect.void,
        restoreWindow: () =>
          Effect.sync(() => {
            created += 1;
            return { state: "created" as const, windowId: "@2" };
          }),
      },
      paneId: "%1",
      cwd,
      workspaceId: "a".repeat(64),
      coordinatorSessionId: coordinator.sessionId,
      wrapperPath: "/bin/pi",
      extensionPath: "/extension.js",
      readyTimeoutMs: 0,
    });

    expect(await reconciler.reconcile()).toEqual({
      outcomes: [{ sessionId: "work-a", name: "quiet-pine", state: "timed-out" }],
    });
    expect(created).toBe(1);
  });
});
