import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as TempDir from "../../../../src/testing/temp-dir";
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { SessionManifest } from "../contracts.js";
import { CloseSource } from "../domain.js";
import type { CurrentWindow, SessionHostShape } from "../host.js";
import {
  SessionAlreadyClosed,
  SessionIdentityConflict,
  SessionNameInvalid,
  createSessionLifecycle,
  type SessionStartInput,
} from "../lifecycle.js";
import { SessionFileInvalid, nodeSessionFileProbe } from "../session-file.js";
import { createFileSessionCatalog } from "../storage.js";

const window: CurrentWindow = {
  socketPath: "/tmp/tmux.sock",
  tmuxSessionId: "$1",
  windowId: "@1",
  bindings: [],
};
const host: SessionHostShape = {
  inspectCurrent: () => Effect.succeed(window),
  bindCurrent: () => Effect.succeed(window),
  renameCurrent: () => Effect.void,
  releaseCurrent: () => Effect.void,
};

async function fixture() {
  const root = await TempDir.forTest("session-lifecycle-");
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const catalog = createFileSessionCatalog(join(root, "agent"));
  const lifecycle = createSessionLifecycle({
    catalog,
    host,
    sessionFiles: nodeSessionFileProbe,
  });
  const input: SessionStartInput = {
    mode: "tui",
    cwd,
    paneId: "%1",
    sessionId: "session-a",
    sessionFile: join(root, "session-a.jsonl"),
  };
  return { root, cwd, catalog, lifecycle, input };
}

async function failureOf<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(effect.pipe(Effect.flip));
}

describe("session lifecycle", () => {
  it("enrolls eligible pending sessions without assigning names", async () => {
    const { cwd, catalog, lifecycle, input } = await fixture();

    expect(await Effect.runPromise(lifecycle.start({ ...input, mode: "rpc" }))).toEqual({
      state: "unmanaged",
      reason: "not interactive",
    });
    expect(await Effect.runPromise(catalog.read(cwd))).toBeNull();

    const first = await Effect.runPromise(lifecycle.start(input));
    const second = await Effect.runPromise(lifecycle.start(input));
    const collision = await Effect.runPromise(
      lifecycle.start({
        ...input,
        sessionId: "session-b",
        sessionFile: join(input.cwd, "session-b.jsonl"),
      }),
    );

    expect(first.state).toBe("managed");
    expect(second.state).toBe("managed");
    expect(collision.state).toBe("managed");
    if (first.state !== "managed" || second.state !== "managed" || collision.state !== "managed") {
      throw new Error("expected managed sessions");
    }
    expect(first.session.record.name).toBeUndefined();
    expect(second.session.record.name).toBeUndefined();
    expect(collision.session.record.name).toBeUndefined();
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions).toHaveLength(2);
    await Effect.runPromise(
      catalog.update(cwd, (manifest) => ({
        ...manifest,
        sessions: manifest.sessions.map((record) =>
          record.sessionId === input.sessionId ? { ...record, name: "green-pine" } : record,
        ),
      })),
    );
    await Effect.runPromise(lifecycle.start(input));
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]?.name).toBeUndefined();
    await Effect.runPromise(lifecycle.start({ ...input, sessionName: "investigate" }));
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]).toMatchObject({
      name: "investigate",
      explicitName: true,
    });
  });

  it("requires explicit adoption for a materialized session and verifies its header identity", async () => {
    const { root, cwd, catalog, lifecycle, input } = await fixture();
    await writeFile(
      input.sessionFile!,
      `${JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd })}\n`,
    );

    expect(await Effect.runPromise(lifecycle.start(input))).toEqual({
      state: "unmanaged",
      reason: "materialized session requires /session-adopt",
    });
    expect(await Effect.runPromise(catalog.read(cwd))).toBeNull();

    await writeFile(
      input.sessionFile!,
      `${JSON.stringify({ type: "session", version: 3, id: "other", cwd })}\n`,
    );
    expect(await failureOf(lifecycle.adopt(input))).toBeInstanceOf(SessionFileInvalid);
    expect(await Effect.runPromise(catalog.read(cwd))).toBeNull();

    await writeFile(
      input.sessionFile!,
      `${JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd })}\n`,
    );
    const adopted = await Effect.runPromise(lifecycle.adopt(input));
    expect(adopted.record.persistence).toEqual({
      state: "materialized",
      sessionFile: join(root, "session-a.jsonl"),
    });
    await Effect.runPromise(lifecycle.close(adopted, CloseSource.SessionDone));
    expect(await failureOf(lifecycle.adopt(input))).toBeInstanceOf(SessionAlreadyClosed);
  });

  it.each([
    ["start", "coordinator"],
    ["start", "closed"],
    ["adopt", "coordinator"],
    ["adopt", "closed"],
  ] as const)(
    "rejects %s when a %s conflict commits after preflight",
    async (operation, conflict) => {
      const { cwd, catalog, lifecycle, input } = await fixture();
      const started = await Effect.runPromise(lifecycle.start(input));
      if (started.state !== "managed") throw new Error("expected managed session");
      await writeFile(
        input.sessionFile!,
        `${JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd })}\n`,
      );
      const { desiredState: _state, ...base } = started.session.record;
      let conflicting: SessionManifest | undefined;
      const bindCurrent = vi.fn(host.bindCurrent);
      const contender = createSessionLifecycle({
        catalog: {
          identity: (path) => catalog.identity(path),
          read: (path) => catalog.read(path),
          update: (path, transform) =>
            catalog
              .update(path, (manifest) =>
                conflict === "coordinator"
                  ? { ...manifest, coordinator: { ...base, role: "coordinator" }, sessions: [] }
                  : {
                      ...manifest,
                      sessions: [
                        {
                          ...started.session.record,
                          desiredState: "closed",
                          closedAt: started.session.record.lastOpenedAt,
                          closedBy: "session-done",
                        },
                      ],
                    },
              )
              .pipe(
                Effect.flatMap((committed) => {
                  conflicting = committed;
                  return catalog.update(path, transform);
                }),
              ),
        },
        host: { ...host, bindCurrent },
        sessionFiles: nodeSessionFileProbe,
      });

      const error = await (operation === "start"
        ? failureOf(contender.start(input))
        : failureOf(contender.adopt(input)));

      expect(error).toBeInstanceOf(
        conflict === "coordinator" ? SessionIdentityConflict : SessionAlreadyClosed,
      );
      expect(error).toMatchObject({
        sessionId: input.sessionId,
        ...(conflict === "coordinator" ? { reason: "session ID belongs to the coordinator" } : {}),
      });
      expect(conflicting).toBeDefined();
      expect(await Effect.runPromise(catalog.read(cwd))).toEqual(conflicting);
      expect(bindCurrent).not.toHaveBeenCalled();
    },
  );

  it("adopts a session whose JSONL cwd is a symlink to the canonical workspace", async () => {
    const { root, cwd, catalog, lifecycle, input } = await fixture();
    const alias = join(root, "workspace-alias");
    await symlink(cwd, alias);
    await writeFile(
      input.sessionFile!,
      `${JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: alias })}\n`,
    );

    const adopted = await Effect.runPromise(lifecycle.adopt({ ...input, cwd: alias }));

    expect(adopted.record.cwd).toBe(cwd);
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]).toMatchObject({
      sessionId: input.sessionId,
      cwd,
      persistence: { state: "materialized", sessionFile: input.sessionFile },
    });
  });

  it("keeps a record pending until the first JSONL header matches the active session", async () => {
    const { cwd, catalog, lifecycle, input } = await fixture();
    const started = await Effect.runPromise(lifecycle.start(input));
    if (started.state !== "managed") throw new Error("expected managed session");

    await writeFile(input.sessionFile!, '{"type":"session","id":"wrong","cwd":"/tmp"}\n');
    expect(
      await failureOf(lifecycle.refreshMaterialization(started.session, input.sessionFile)),
    ).toBeInstanceOf(SessionFileInvalid);
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]?.persistence.state).toBe(
      "pending",
    );

    await writeFile(
      input.sessionFile!,
      `${JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd })}\n`,
    );
    const refreshed = await Effect.runPromise(
      lifecycle.refreshMaterialization(started.session, input.sessionFile),
    );
    expect(refreshed.record.persistence.state).toBe("materialized");
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]?.persistence).toEqual({
      state: "materialized",
      sessionFile: input.sessionFile,
    });
  });

  it("rejects a whitespace rename with an identifiable error without changing the catalog", async () => {
    const { cwd, catalog, lifecycle, input } = await fixture();
    const started = await Effect.runPromise(lifecycle.start(input));
    if (started.state !== "managed") throw new Error("expected managed session");
    const before = await Effect.runPromise(catalog.read(cwd));

    const error = await failureOf(lifecycle.rename(started.session, " \t "));

    expect(error).toBeInstanceOf(SessionNameInvalid);
    expect(String(error)).toBe("SessionNameInvalid");
    expect(error).toMatchObject({
      _tag: "SessionNameInvalid",
      requestedName: " \t ",
    });
    expect(await Effect.runPromise(catalog.read(cwd))).toEqual(before);
  });

  it("writes the closure source without changing history persistence", async () => {
    const { cwd, catalog, lifecycle, input } = await fixture();
    const started = await Effect.runPromise(lifecycle.start(input));
    if (started.state !== "managed") throw new Error("expected managed session");

    await Effect.runPromise(lifecycle.close(started.session, CloseSource.CtrlD));

    const record = (await Effect.runPromise(catalog.read(cwd)))?.sessions[0];
    expect(record).toMatchObject({
      sessionId: input.sessionId,
      desiredState: "closed",
      closedBy: "ctrl-d",
      persistence: { state: "pending" },
    });
  });
});
