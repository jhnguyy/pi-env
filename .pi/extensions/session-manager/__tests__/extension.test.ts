import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  ManifestCommitFailure,
  ensureCoordinator,
  makeSessionCatalog,
  registerSessionManager,
  workspaceId as workspaceIdFor,
  type CurrentWindow,
  type SessionCatalogShape,
  type SessionFileProbe,
  type SessionHostShape,
} from "../index.js";

type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;
type CompatibleEditor = ReturnType<EditorFactory> & {
  actionHandlers: Map<string, () => void>;
  onCtrlD(): void;
};
const cast = <T>(value: unknown): T => value as T;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session-manager extension", () => {
  it("rejects a partial managed launch before catalog or host effects", async () => {
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const notices: string[] = [];
    let shutdownCalls = 0;
    let effectCalls = 0;
    const unexpected = <A>() =>
      Effect.sync(() => {
        effectCalls += 1;
        return {} as A;
      });
    const pi = cast<ExtensionAPI>({
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
        handlers.set(event, handler),
      registerCommand: () => {},
      getSessionName: () => undefined,
      setSessionName: () => {},
    });
    registerSessionManager(pi, {
      catalog: {
        identity: () => unexpected(),
        read: () => unexpected(),
        update: () => unexpected(),
      },
      host: {
        inspectCurrent: () => unexpected(),
        bindCurrent: () => unexpected(),
        renameCurrent: () => unexpected(),
        releaseCurrent: () => unexpected(),
      },
      environment: {
        TMUX_PANE: "%1",
        PI_ENV_SESSION_MANAGER_EXPECTED: "1",
      },
    });
    const ctx = cast<ExtensionContext>({
      mode: "tui",
      cwd: "/workspace",
      sessionManager: {
        getSessionId: () => "work-a",
        getSessionFile: () => undefined,
      },
      ui: {
        notify: (message: string) => notices.push(message),
      },
      shutdown: () => {
        shutdownCalls += 1;
      },
    });

    await handlers.get("session_start")?.({} as never, ctx);

    expect(effectCalls).toBe(0);
    expect(shutdownCalls).toBe(1);
    expect(notices[0]).toContain("LaunchParseFailure");
  });

  it("rejects a restored-work coordinator mismatch before durable or tmux mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-extension-preflight-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const catalog = makeSessionCatalog(join(root, "agent"));
    await Effect.runPromise(
      ensureCoordinator({ catalog, cwd, entropy: () => 0, sessionId: "coordinator-a" }),
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
    const before = await Effect.runPromise(catalog.read(cwd));
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    let hostCalls = 0;
    let shutdownCalls = 0;
    const pi = cast<ExtensionAPI>({
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
        handlers.set(event, handler),
      registerCommand: () => {},
      getSessionName: () => "quiet-pine",
      setSessionName: () => {},
    });
    const noHostEffect = <A>() =>
      Effect.sync(() => {
        hostCalls += 1;
        return {} as A;
      });
    registerSessionManager(pi, {
      catalog,
      host: {
        inspectCurrent: () => noHostEffect(),
        bindCurrent: () => noHostEffect(),
        renameCurrent: () => noHostEffect(),
        releaseCurrent: () => noHostEffect(),
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
    const ctx = cast<ExtensionContext>({
      mode: "tui",
      cwd,
      sessionManager: { getSessionId: () => "work-a", getSessionFile: () => undefined },
      ui: { notify: () => {} },
      shutdown: () => {
        shutdownCalls += 1;
      },
    });

    await handlers.get("session_start")?.({} as never, ctx);

    expect(hostCalls).toBe(0);
    expect(shutdownCalls).toBe(1);
    expect(await Effect.runPromise(catalog.read(cwd))).toEqual(before);
  });

  it("composes the current editor and closes before its Ctrl+D callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-extension-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const persistedCatalog = makeSessionCatalog(join(root, "agent"));
    let rejectUpdate = false;
    const catalog: SessionCatalogShape = {
      identity: (path) => persistedCatalog.identity(path),
      read: (path) => persistedCatalog.read(path),
      update: (path, transform) =>
        rejectUpdate
          ? Effect.fail(new ManifestCommitFailure({ path, cause: new Error("write failed") }))
          : persistedCatalog.update(path, transform),
    };
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
    let name: string | undefined;
    let editorFactory: EditorFactory | undefined;
    let previousCtrlDCalls = 0;
    const editor = cast<CompatibleEditor>({
      actionHandlers: new Map<string, () => void>(),
      onCtrlD: () => {
        previousCtrlDCalls += 1;
      },
    });
    const previousFactory: EditorFactory = () => editor;
    editorFactory = previousFactory;
    const pi = cast<ExtensionAPI>({
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
        handlers.set(event, handler);
      },
      registerCommand: (
        command: string,
        options: { handler: (args: string, ctx: ExtensionContext) => unknown },
      ) => commands.set(command, options.handler),
      getSessionName: () => name,
      setSessionName: (value: string) => {
        name = value;
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const notifications: string[] = [];
    let shutdownCalls = 0;
    const ctx = cast<ExtensionContext>({
      mode: "tui",
      cwd,
      sessionManager: {
        getSessionId: () => "session-a",
        getSessionFile: () => join(root, "session-a.jsonl"),
      },
      ui: {
        getEditorComponent: () => editorFactory,
        setEditorComponent: (factory: EditorFactory | undefined) => {
          editorFactory = factory;
        },
        setStatus: () => {},
        notify: (message: string) => notifications.push(message),
      },
      shutdown: () => {
        shutdownCalls += 1;
      },
    });
    const currentWindow: CurrentWindow = {
      socketPath: "/tmp/tmux.sock",
      tmuxSessionId: "$1",
      windowId: "@1",
      bindings: [],
    };
    const host: SessionHostShape = {
      inspectCurrent: () => Effect.succeed(currentWindow),
      bindCurrent: () => Effect.succeed(currentWindow),
      renameCurrent: () => Effect.void,
      releaseCurrent: () => Effect.void,
    };
    const sessionFiles: SessionFileProbe = {
      exists: () => Effect.succeed(false),
      verify: () => Effect.void,
    };
    registerSessionManager(pi, {
      catalog,
      host,
      sessionFiles,
      entropy: () => 0,
      environment: { TMUX_PANE: "%1" },
    });

    await handlers.get("session_start")?.({} as never, ctx);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    await handlers.get("session_info_changed")?.(cast<never>({ name: "quiet-pine" }), ctx);
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]).toMatchObject({
      name: "quiet-pine",
    });
    expect(editorFactory).not.toBe(previousFactory);
    const composed = cast<CompatibleEditor>(
      editorFactory?.(cast<never>({}), cast<never>({}), cast<never>({})),
    );
    expect(composed).toBe(editor);

    rejectUpdate = true;
    composed.onCtrlD();
    composed.onCtrlD();
    await expect.poll(() => notifications.length).toBe(1);
    expect(previousCtrlDCalls).toBe(0);
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]).toMatchObject({
      desiredState: "open",
    });

    rejectUpdate = false;
    composed.onCtrlD();
    await expect.poll(() => previousCtrlDCalls).toBe(1);
    expect(shutdownCalls).toBe(0);
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]).toMatchObject({
      desiredState: "closed",
      closedBy: "ctrl-d",
    });
    expect(notifications[0]).toContain("Session finalization failed");
  });

  it("keeps an incompatible editor and reports that Ctrl+D composition is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-extension-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    let factory: EditorFactory | undefined = () => cast<ReturnType<EditorFactory>>({});
    const notices: string[] = [];
    let releaseCalls = 0;
    const pi = cast<ExtensionAPI>({
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
        handlers.set(event, handler),
      registerCommand: () => {},
      getSessionName: () => "amber-fox",
      setSessionName: () => {},
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const ctx = cast<ExtensionContext>({
      mode: "tui",
      cwd,
      sessionManager: {
        getSessionId: () => "session-a",
        getSessionFile: () => join(root, "session-a.jsonl"),
      },
      ui: {
        getEditorComponent: () => factory,
        setEditorComponent: (value: EditorFactory | undefined) => {
          factory = value;
        },
        setStatus: () => {},
        notify: (message: string) => notices.push(message),
      },
      shutdown: () => {},
    });
    const catalog = makeSessionCatalog(join(root, "agent"));
    const window: CurrentWindow = {
      socketPath: "/tmp/tmux.sock",
      tmuxSessionId: "$1",
      windowId: "@1",
      bindings: [],
    };
    registerSessionManager(pi, {
      catalog,
      host: {
        inspectCurrent: () => Effect.succeed(window),
        bindCurrent: () => Effect.succeed(window),
        renameCurrent: () => Effect.void,
        releaseCurrent: () =>
          Effect.sync(() => {
            releaseCalls += 1;
          }),
      },
      sessionFiles: { exists: () => Effect.succeed(false), verify: () => Effect.void },
      entropy: () => 0,
      environment: { TMUX_PANE: "%1" },
    });

    await handlers.get("session_start")?.({} as never, ctx);
    factory?.(cast<never>({}), cast<never>({}), cast<never>({}));

    expect(notices).toContain(
      "Session manager cannot compose Ctrl+D with the configured editor. Use /session-done to finalize this session.",
    );

    await handlers.get("session_shutdown")?.(cast<never>({ reason: "quit" }), ctx);
    expect(releaseCalls).toBe(1);
    expect((await Effect.runPromise(catalog.read(cwd)))?.sessions[0]).toMatchObject({
      desiredState: "open",
    });
  });
});
