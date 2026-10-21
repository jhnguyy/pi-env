import { join } from "node:path";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ManifestCommitFailure } from "../contracts.js";
import { ensureCoordinator } from "../coordinator.js";
import { windowLabel } from "../host.js";
import { workspaceId as workspaceIdFor } from "../runtime-path.js";
import { createExtensionFixture } from "./extension-fixture.js";

describe("session-manager extension", () => {
  it("rejects a partial managed launch before catalog or host effects", async () => {
    const f = await createExtensionFixture();
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

    await f.emit({ type: "session_start", reason: "startup" });

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
    let rejectUpdate = false;
    f.register({
      catalog: {
        identity: (path) => f.catalog.identity(path),
        read: (path) => f.catalog.read(path),
        update: (path, transform) =>
          rejectUpdate
            ? Effect.fail(new ManifestCommitFailure({ path, cause: new Error("write failed") }))
            : f.catalog.update(path, transform),
      },
    });
    const previousFactory = f.native.editorFactory;

    await f.emit({ type: "session_start", reason: "startup" });
    expect(f.native.editorFactory).not.toBe(previousFactory);
    const composed = f.renderEditor();
    expect(composed).toBe(f.editor);

    rejectUpdate = true;
    composed.onCtrlD();
    composed.onCtrlD();
    await expect.poll(() => f.native.notifications.length).toBe(1);
    expect(f.native.ctrlDCalls).toBe(0);
    expect((await f.readManifest())?.sessions[0]).toMatchObject({ desiredState: "open" });

    rejectUpdate = false;
    composed.onCtrlD();
    await expect.poll(() => f.native.ctrlDCalls).toBe(1);
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
    await binding.entered;
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
      await binding.entered;
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
