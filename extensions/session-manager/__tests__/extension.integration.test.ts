import { join } from "node:path";
import { lstat, unlink, writeFile } from "node:fs/promises";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished } from "vitest";
import { Effect } from "effect";
import { ManifestCommitFailure } from "../contracts.js";
import { ensureCoordinator } from "../coordinator.js";
import { createTmuxSessionHost, windowLabel } from "../host.js";
import { resolveRuntimePaths, workspaceId as workspaceIdFor } from "../runtime-path.js";
import { RuntimeMethod, runtimeRequest } from "../runtime-bus.js";
import { createExtensionFixture } from "./extension-fixture.js";

async function coordinatorFixture() {
  const f = await createExtensionFixture();
  const coordinator = await Effect.runPromise(
    ensureCoordinator({ catalog: f.catalog, cwd: f.cwd }),
  );
  f.native.session = { id: coordinator.sessionId };
  const environment = {
    XDG_RUNTIME_DIR: f.root,
    TMUX_PANE: "%1",
    PI_ENV_SESSION_MANAGER_EXPECTED: "1",
    PI_ENV_SESSION_MANAGER_ROLE: "coordinator",
    PI_ENV_SESSION_MANAGER_WORKSPACE_ID: workspaceIdFor(coordinator.cwd),
    PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID: coordinator.sessionId,
    PI_ENV_SESSION_MANAGER_LAUNCH_ID: "123e4567-e89b-42d3-a456-426614174000",
    PI_ENV_SESSION_MANAGER_EXTENSION: "/extension.js",
    PI_ENV_PI_WRAPPER: "/wrapper",
  };
  const paths = await Effect.runPromise(resolveRuntimePaths(coordinator.cwd, environment));
  expect(paths.directory).toBe(join(f.root, "pi-env", "session-manager"));
  await writeFile(
    paths.claimPath,
    JSON.stringify({
      version: 1,
      workspaceId: environment.PI_ENV_SESSION_MANAGER_WORKSPACE_ID,
      coordinatorSessionId: coordinator.sessionId,
      launchId: environment.PI_ENV_SESSION_MANAGER_LAUNCH_ID,
      pid: process.pid,
      createdAt: Date.now(),
    }),
  );
  return { ...f, environment, paths, coordinator };
}

// These workflows use real file commits and kernel locks while scripting only the tmux boundary.
describe("session-manager extension", () => {
  it.each(["startup", "adopt"] as const)(
    "does not grant manifest authority after %s binding conflict",
    async (operation) => {
      const f = await createExtensionFixture();
      const timestamp = new Date().toISOString();
      await Effect.runPromise(
        f.catalog.update(f.cwd, (manifest) => ({
          ...manifest,
          sessions: [
            {
              version: 1,
              sessionId: "session-a",
              cwd: manifest.canonicalCwd,
              name: "incumbent",
              explicitName: true,
              persistence: { state: "pending" },
              createdAt: timestamp,
              lastOpenedAt: timestamp,
              role: "work",
              desiredState: "open",
            },
          ],
        })),
      );
      const file = join(f.root, "session.jsonl");
      await writeFile(
        file,
        JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: f.cwd }) + "\n",
      );
      if (operation === "adopt") f.native.session.file = file;
      await Effect.runPromise(f.host.bindCurrent("%1", "session-a"));
      onTestFinished(() => Effect.runPromise(f.host.releaseCurrent("%1", "session-a")));
      f.register({
        host: createTmuxSessionHost(f.tmux.exec, {
          ownerPid: process.pid + 1,
          processAlive: () => true,
        }),
      });
      if (operation === "startup") await f.emit({ type: "session_start", reason: "startup" });
      else await f.emit({ type: "command", name: "session-adopt" });
      expect(f.native.notifications.at(-1)?.message).toContain("WindowBindingConflict");
      const before = await f.readManifest();
      f.native.session.file = file;
      await f.emit({ type: "session_info_changed", name: "intruder" });
      await f.emit({ type: "agent_end", messages: [] });
      await f.emit({ type: "command", name: "session-status" });
      await f.emit({ type: "command", name: "session-done" });
      await f.emit({ type: "session_shutdown", reason: "quit" });
      expect(await f.readManifest()).toEqual(before);
      expect(f.tmux.tags["@1"]).toBe("session-a");
      expect(f.tmux.owners["@1"]).toBe(`${process.pid}`);
      expect(f.native.shutdownCalls).toBe(0);
    },
  );

  it("waits for coordinator enrollment on shutdown without starting a late bus", async () => {
    const f = await coordinatorFixture();
    f.register({ environment: f.environment });
    const originalEditor = f.native.editorFactory;
    const binding = f.pauseNextBind();
    const starting = f.emit({ type: "session_start", reason: "startup" });
    await binding.waitUntilEntered(starting);
    const ending = f.emit({ type: "session_shutdown", reason: "quit" });
    binding.release();
    await Promise.all([starting, ending]);
    expect(f.tmux.tags["@1"]).toBeUndefined();
    expect(f.native.editorFactory).toBe(originalEditor);
    await expect(lstat(f.paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still requires the coordinator claim on initial startup", async () => {
    const f = await coordinatorFixture();
    await unlink(f.paths.claimPath);
    f.register({ environment: f.environment });
    await f.emit({ type: "session_start", reason: "startup" });
    expect(f.native.shutdownCalls).toBe(1);
    expect(f.tmux.tags["@1"]).toBeUndefined();
    await expect(lstat(f.paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reloads a coordinator after consuming its one-shot startup claim", async () => {
    const f = await coordinatorFixture();
    f.register({ environment: f.environment });
    await f.emit({ type: "session_start", reason: "startup" });
    expect(f.native.shutdownCalls).toBe(0);
    await expect(lstat(f.paths.claimPath)).rejects.toMatchObject({ code: "ENOENT" });
    await f.emit({ type: "session_shutdown", reason: "reload" });
    f.register({ environment: f.environment });
    await f.emit({ type: "session_start", reason: "reload" });
    expect(f.native.shutdownCalls).toBe(0);
    expect(f.tmux.tags["@1"]).toBe(f.coordinator.sessionId);
    await expect(
      Effect.runPromise(
        runtimeRequest({
          socketPath: f.paths.socketPath,
          workspaceId: f.environment.PI_ENV_SESSION_MANAGER_WORKSPACE_ID,
          coordinatorSessionId: f.coordinator.sessionId,
          method: RuntimeMethod.Ping,
          timeoutMs: 2_000,
        }),
      ),
    ).resolves.toEqual({ alive: true });
  });

  it("rejects a partial managed launch before catalog or host effects", async () => {
    const f = await createExtensionFixture();
    const binding = f.pauseNextBind();
    let effectCalls = 0;
    const unexpected = () =>
      Effect.suspend(() => {
        effectCalls += 1;
        return Effect.die("Unexpected effect before launch validation");
      });
    f.register({
      catalog: { identity: unexpected, read: unexpected, update: unexpected },
      host: {
        inspectCurrent: unexpected,
        bindCurrent: unexpected,
        renameCurrent: unexpected,
        releaseCurrent: unexpected,
      },
      environment: { TMUX_PANE: "%1", PI_ENV_SESSION_MANAGER_EXPECTED: "1" },
    });

    const starting = f.emit({ type: "session_start", reason: "startup" });
    await expect(binding.waitUntilEntered(starting)).rejects.toThrow("before binding pause");

    expect(effectCalls).toBe(0);
    expect(f.native.shutdownCalls).toBe(1);
    expect(f.native.notifications.map((notice) => notice.level)).toEqual(["error"]);
  });

  it("rejects a restored-work coordinator mismatch before durable or tmux mutation", async () => {
    const f = await createExtensionFixture();
    f.native.session = { id: "work-a", name: "quiet-pine" };
    await Effect.runPromise(ensureCoordinator({ catalog: f.catalog, cwd: f.cwd }));
    const timestamp = new Date().toISOString();
    await Effect.runPromise(
      f.catalog.update(f.cwd, (manifest) => ({
        ...manifest,
        sessions: [
          {
            version: 1,
            sessionId: "work-a",
            cwd: f.cwd,
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
    const before = await f.readManifest();
    let hostCalls = 0;
    const unexpected = () =>
      Effect.suspend(() => {
        hostCalls += 1;
        return Effect.die("Unexpected host effect before launch validation");
      });
    f.register({
      host: {
        inspectCurrent: unexpected,
        bindCurrent: unexpected,
        renameCurrent: unexpected,
        releaseCurrent: unexpected,
      },
      environment: {
        TMUX_PANE: "%1",
        PI_ENV_SESSION_MANAGER_EXPECTED: "1",
        PI_ENV_SESSION_MANAGER_ROLE: "work",
        PI_ENV_SESSION_MANAGER_WORKSPACE_ID: workspaceIdFor(before!.canonicalCwd),
        PI_ENV_SESSION_MANAGER_COORDINATOR_ID: "coordinator-wrong",
        PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID: "work-a",
        PI_ENV_SESSION_MANAGER_LAUNCH_ID: "123e4567-e89b-42d3-a456-426614174000",
        PI_ENV_SESSION_MANAGER_EXTENSION: "/extension.js",
      },
    });

    await f.emit({ type: "session_start", reason: "startup" });

    expect(hostCalls).toBe(0);
    expect(f.native.shutdownCalls).toBe(1);
    const after = await f.readManifest();
    expect(after?.revision).toBe(before?.revision);
    expect(after?.sessions[0]).toMatchObject({ sessionId: "work-a", desiredState: "open" });
  });

  it("composes the current editor and closes before its Ctrl+D callback", async () => {
    const f = await createExtensionFixture();
    f.native.session.file = join(f.root, "session-a.jsonl");
    const order: string[] = [];
    const originalCtrlD = f.editor.onCtrlD;
    f.editor.onCtrlD = () => {
      order.push("callback");
      originalCtrlD();
    };
    let rejectUpdate = false;
    f.register({
      catalog: {
        identity: (path) => f.catalog.identity(path),
        read: (path) => f.catalog.read(path),
        update: (path, transform) =>
          rejectUpdate
            ? Effect.fail(new ManifestCommitFailure({ path, cause: new Error("write failed") }))
            : f.catalog.update(path, transform).pipe(
                Effect.tap((manifest) =>
                  Effect.sync(() => {
                    if (manifest.sessions[0]?.desiredState === "closed") order.push("closed");
                  }),
                ),
              ),
      },
    });
    await f.emit({ type: "session_start", reason: "startup" });
    const composed = f.renderEditor();
    expect(composed).toBe(f.editor);

    rejectUpdate = true;
    composed.onCtrlD();
    composed.onCtrlD();
    await f.notificationDelivered;
    expect(f.native.notifications).toHaveLength(1);
    expect(f.native.ctrlDCalls).toBe(0);
    expect((await f.readManifest())?.sessions[0]).toMatchObject({ desiredState: "open" });

    rejectUpdate = false;
    composed.onCtrlD();
    await f.ctrlDCompleted;
    expect(order).toEqual(["closed", "callback"]);
    expect(f.native.ctrlDCalls).toBe(1);
    expect(f.native.shutdownCalls).toBe(0);
    expect((await f.readManifest())?.sessions[0]).toMatchObject({
      desiredState: "closed",
      closedBy: "ctrl-d",
    });
  });

  it("keeps an incompatible editor and reports that Ctrl+D composition is unavailable", async () => {
    const f = await createExtensionFixture();
    f.native.session.name = "amber-fox";
    f.native.session.file = join(f.root, "session-a.jsonl");
    f.native.editorFactory = () => ({}) as EditorComponent;
    f.register();

    await f.emit({ type: "session_start", reason: "startup" });
    f.renderEditor();
    expect(f.native.notifications).toHaveLength(1);
    expect(f.native.notifications[0]?.message).toContain("cannot compose Ctrl+D");

    await f.emit({ type: "session_shutdown", reason: "quit" });
    expect((await f.readManifest())?.sessions[0]).toMatchObject({ desiredState: "open" });
  });

  // E2E cannot hold enrollment open for an exact name-event interleaving.
  it("keeps native sessions unnamed and applies renames delivered during enrollment", async () => {
    const f = await createExtensionFixture();
    f.register();
    await f.emit({ type: "session_start", reason: "startup" });
    expect(f.native.session.name).toBeUndefined();
    expect((await f.readManifest())?.sessions[0]?.name).toBeUndefined();
    await f.emit({ type: "session_shutdown", reason: "quit" });

    const binding = f.pauseNextBind();
    const starting = f.emit({ type: "session_start", reason: "new" }, { id: "session-b" });
    await binding.waitUntilEntered(starting);
    const renaming = f.emit({ type: "session_info_changed", name: "investigate-resume" });
    binding.release();
    await Promise.all([starting, renaming]);

    expect(f.native.session.name).toBe("investigate-resume");
    expect(
      (await f.readManifest())?.sessions.find((record) => record.sessionId === "session-b")?.name,
    ).toBe("investigate-resume");
    expect(f.tmux.labels["@1"]).toBe("investigate-resume");

    await f.emit({ type: "session_info_changed", name: undefined });
    expect(f.native.session.name).toBeUndefined();
    expect(f.tmux.labels["@1"]).toBe("investigate-resume");
  });

  // E2E cannot hold enrollment across shutdown or session replacement.
  it.each(["shutdown", "session replacement"] as const)(
    "discards pending renames and preserves binding ownership after %s",
    async (transition) => {
      const f = await createExtensionFixture();
      f.register();
      const binding = f.pauseNextBind();
      const starting = f.emit({ type: "session_start", reason: "startup" });
      await binding.waitUntilEntered(starting);
      const renaming = f.emit({ type: "session_info_changed", name: "obsolete-label" });
      const ending =
        transition === "shutdown"
          ? f.emit({ type: "session_shutdown", reason: "quit" })
          : f.emit({ type: "session_start", reason: "new" }, { id: "session-b" });
      binding.release();
      await Promise.all([starting, renaming, ending]);

      expect(f.tmux.tags["@1"]).toBe(transition === "shutdown" ? undefined : "session-b");
      const manifest = await f.readManifest();
      expect(manifest?.sessions.map((record) => record.name)).toEqual(
        transition === "shutdown" ? [undefined] : [undefined, undefined],
      );
      if (transition === "session replacement") {
        expect(f.tmux.labels["@1"]).toBe(windowLabel("session-b"));
        expect(manifest?.sessions.map((record) => record.sessionId)).toEqual([
          "session-a",
          "session-b",
        ]);
        await f.emit({ type: "session_shutdown", reason: "quit" });
        expect(f.tmux.tags["@1"]).toBeUndefined();
      }
    },
  );
});
