import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { onTestFinished } from "vitest";
import { createTmuxSessionHost } from "../host.js";
import { registerSessionManager, type SessionManagerOptions } from "../index.js";
import { createFileSessionCatalog } from "../storage.js";
import { executor } from "./tmux-executor.js";

type Event = SessionStartEvent | SessionInfoChangedEvent | SessionShutdownEvent;
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type Editor = ReturnType<EditorFactory> & {
  actionHandlers: Map<string, () => void>;
  onCtrlD(): void;
};
type Session = { id: string; name?: string; file?: string };
type NativeContext = Pick<ExtensionContext, "mode" | "cwd" | "shutdown"> & {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">;
  ui: Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent" | "notify">;
};

export async function createExtensionFixture() {
  const root = await mkdtemp(join(tmpdir(), "session-extension-"));
  let close = async () => {};
  onTestFinished(async () => {
    const failures: unknown[] = [];
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Session fixture cleanup failed");
  });
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const catalog = createFileSessionCatalog(join(root, "agent"));
  const tmux = executor({}, {}, join(root, "tmux.sock"));
  const handlers = new Map<string, unknown>();
  const pending = new Set<Promise<void>>();
  const eventFailures: unknown[] = [];
  const releases = new Set<() => void>();
  let nextBind: (() => Promise<void>) | undefined;
  const host = createTmuxSessionHost(async (command, args) => {
    const result = await tmux.exec(command, args);
    if (nextBind && args.includes("rename-window")) {
      const wait = nextBind;
      nextBind = undefined;
      await wait();
    }
    return result;
  });
  const native = {
    session: { id: "session-a" } as Session,
    editorFactory: undefined as EditorFactory | undefined,
    notifications: [] as { message: string; level: string }[],
    shutdownCalls: 0,
    ctrlDCalls: 0,
  };
  const editor = {
    actionHandlers: new Map(),
    onCtrlD: () => {
      native.ctrlDCalls += 1;
    },
  } as Editor;
  native.editorFactory = () => editor;
  const pi: Partial<ExtensionAPI> = {
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    },
    registerCommand: () => {},
    getSessionName: () => native.session.name,
    setSessionName: (name: string) => {
      native.session.name = name.trim() || undefined;
    },
  };
  let registered = false;
  function emit(event: Event, session = native.session): Promise<void> {
    if (event.type === "session_start") native.session = session;
    if (event.type === "session_info_changed") session.name = event.name;
    const registeredHandler = handlers.get(event.type);
    if (typeof registeredHandler !== "function")
      throw new Error(`No registered handler for ${event.type}`);
    const handler = registeredHandler as (event: Event, ctx: ExtensionContext) => unknown;
    const ctx: NativeContext = {
      mode: "tui",
      cwd,
      sessionManager: {
        getSessionId: () => session.id,
        getSessionFile: () => session.file,
      },
      ui: {
        getEditorComponent: () => native.editorFactory,
        setEditorComponent: (factory: EditorFactory | undefined) => {
          native.editorFactory = factory;
        },
        notify: (message: string, level: "info" | "warning" | "error" = "info") =>
          native.notifications.push({ message, level }),
      },
      shutdown: () => {
        native.shutdownCalls += 1;
      },
    };
    const task = Promise.resolve(handler(event, ctx as ExtensionContext)).then(() => {});
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error) => {
        eventFailures.push(error);
        pending.delete(task);
      },
    );
    return task;
  }
  close = async () => {
    for (const release of releases) release();
    await Promise.allSettled([...pending]);
    const failures = eventFailures;
    if (registered) {
      try {
        await emit({ type: "session_shutdown", reason: "quit" });
      } catch (error) {
        if (!failures.includes(error)) failures.push(error);
      }
    }
    if (tmux.tags["@1"]) failures.push(new Error("Session binding survived fixture shutdown"));
    if (failures.length)
      throw new AggregateError(failures, "Pending session events failed during cleanup");
  };
  return {
    root,
    cwd,
    catalog,
    host,
    native,
    editor,
    tmux,
    emit,
    readManifest: () => Effect.runPromise(catalog.read(cwd)),
    register: (options: Partial<SessionManagerOptions> = {}) => {
      if (registered) throw new Error("Session manager already registered");
      registerSessionManager(pi as ExtensionAPI, {
        catalog,
        host,
        environment: { TMUX_PANE: "%1" },
        ...options,
      });
      registered = true;
    },
    renderEditor: () => {
      if (!native.editorFactory) throw new Error("No installed editor factory");
      return native.editorFactory({} as never, {} as never, {} as never) as Editor;
    },
    pauseNextBind: () => {
      if (nextBind) throw new Error("A binding pause is already pending");
      let entered!: () => void;
      let release!: () => void;
      const observed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.add(release);
      nextBind = async () => {
        entered();
        await resumed;
        releases.delete(release);
      };
      return { entered: observed, release };
    },
  };
}
