import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  CloseSource,
  SessionAlreadyClosed,
  SessionFileInvalid,
  makeSessionCatalog,
  createSessionLifecycle,
  nodeSessionFileProbe,
  type CurrentWindow,
  type SessionHostShape,
  type SessionStartInput,
} from "../index.js";

const roots: string[] = [];
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
  const root = await mkdtemp(join(tmpdir(), "session-lifecycle-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const catalog = makeSessionCatalog(join(root, "agent"));
  const lifecycle = createSessionLifecycle({
    catalog,
    host,
    sessionFiles: nodeSessionFileProbe,
    entropy: () => 0,
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session lifecycle", () => {
  it("enrolls only an eligible pending tmux session and preserves its generated name", async () => {
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
      return;
    }
    expect(first.session.record.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(second.session.record.name).toBe(first.session.record.name);
    expect(collision.session.record.name).not.toBe(first.session.record.name);
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions).toHaveLength(2);
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

  it("adopts a session whose JSONL cwd is a symlink to the canonical workspace", async () => {
    const { root, cwd, lifecycle, input } = await fixture();
    const alias = join(root, "workspace-alias");
    await symlink(cwd, alias);
    await writeFile(
      input.sessionFile!,
      `${JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: alias })}\n`,
    );

    const adopted = await Effect.runPromise(lifecycle.adopt({ ...input, cwd: alias }));

    expect(adopted.record.cwd).toBe(cwd);
  });

  it("keeps a record pending until the first JSONL header matches the active session", async () => {
    const { cwd, catalog, lifecycle, input } = await fixture();
    const started = await Effect.runPromise(lifecycle.start(input));
    if (started.state !== "managed") throw new Error("expected managed session");

    await writeFile(input.sessionFile!, '{"type":"session","id":"wrong","cwd":"/tmp"}\n');
    expect(
      await failureOf(lifecycle.refreshMaterialization(started.session, input.sessionFile)),
    ).toBeInstanceOf(SessionFileInvalid);
    expect(
      (await Effect.runPromise(catalog.read(cwd)))?.sessions[0]?.persistence.state,
    ).toBe("pending");

    await writeFile(
      input.sessionFile!,
      `${JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd })}\n`,
    );
    const refreshed = await Effect.runPromise(
      lifecycle.refreshMaterialization(started.session, input.sessionFile),
    );
    expect(refreshed.record.persistence.state).toBe("materialized");
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
