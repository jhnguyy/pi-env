import {
  CustomEditor,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Effect, Layer } from "effect";
import { CloseSource, secureNameEntropy, type NameEntropy } from "./domain.js";
import { SessionHost, tmuxSessionHostLayer, type SessionHostShape } from "./host.js";
import {
  SessionBindingFailed,
  SessionWindowSyncFailed,
  createSessionLifecycle,
  type ManagedSession,
  type SessionLifecycle,
  type SessionStartInput,
} from "./lifecycle.js";
import { nodeSessionFileProbe, type SessionFileProbe } from "./session-file.js";
import {
  SessionCatalog,
  sessionCatalogLayer,
  type SessionCatalogShape,
} from "./storage.js";

type Environment = Readonly<Record<string, string | undefined>>;
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;
type EditorWithCtrlD = ReturnType<EditorFactory> & {
  readonly actionHandlers: Map<string, () => void>;
  onCtrlD?: () => void;
};

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { _tag: string; reason?: string; name?: string };
    return [tagged._tag, tagged.reason ?? tagged.name].filter(Boolean).join(": ");
  }
  return error instanceof Error ? error.message : String(error);
}

function startInput(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  environment: Environment,
): SessionStartInput {
  return {
    mode: ctx.mode,
    cwd: ctx.cwd,
    paneId: environment.TMUX_PANE,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionName: pi.getSessionName(),
  };
}

function isEditorWithCtrlD(editor: ReturnType<EditorFactory>): editor is EditorWithCtrlD {
  return "actionHandlers" in editor && editor.actionHandlers instanceof Map;
}

export type SessionManagerOptions = {
  readonly catalog: SessionCatalogShape;
  readonly host: SessionHostShape;
  readonly sessionFiles?: SessionFileProbe;
  readonly entropy?: NameEntropy;
  readonly environment?: Environment;
};

export function registerSessionManager(pi: ExtensionAPI, options: SessionManagerOptions): void {
  const environment = options.environment ?? process.env;
  const host = options.host;
  const lifecycle: SessionLifecycle = createSessionLifecycle({
    catalog: options.catalog,
    host: options.host,
    sessionFiles: options.sessionFiles ?? nodeSessionFileProbe,
    entropy: options.entropy ?? secureNameEntropy,
  });
  let managed: ManagedSession | undefined;
  let finalization: Promise<void> | undefined;
  let syncingName = false;
  let installedFactory: EditorFactory | undefined;
  let previousFactory: EditorFactory | undefined;
  let generation = 0;
  let transitions: Promise<void> = Promise.resolve();

  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
  const queue = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = transitions.then(operation, operation);
    transitions = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const notifyError = (ctx: ExtensionContext, action: string, error: unknown) => {
    ctx.ui.notify(`${action} failed. ${errorMessage(error)}`, "error");
  };

  const finalize = (
    ctx: ExtensionContext,
    source: CloseSource,
    shutdown: () => void = () => ctx.shutdown(),
  ) => {
    if (!managed || finalization) return;
    const target = managed;
    const targetGeneration = generation;
    finalization = queue(() =>
      run(lifecycle.close(target, source, ctx.sessionManager.getSessionFile())),
    )
      .then(() => {
        if (targetGeneration !== generation) return;
        managed = undefined;
        shutdown();
      })
      .catch((error: unknown) => notifyError(ctx, "Session finalization", error))
      .finally(() => {
        finalization = undefined;
      });
  };

  const installEditor = (ctx: ExtensionContext, coordinator: boolean) => {
    previousFactory = ctx.ui.getEditorComponent();
    installedFactory = (tui, theme, keybindings) => {
      const editor = previousFactory
        ? previousFactory(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);
      if (!isEditorWithCtrlD(editor)) {
        ctx.ui.notify(
          "Session manager cannot compose Ctrl+D with the configured editor. Use /session-done to finalize this session.",
          "error",
        );
        return editor;
      }
      const previousCtrlD = editor.onCtrlD;
      editor.onCtrlD = () => {
        if (coordinator) {
          if (previousCtrlD) previousCtrlD();
          else ctx.shutdown();
          return;
        }
        if (managed) finalize(ctx, CloseSource.CtrlD, previousCtrlD ?? (() => ctx.shutdown()));
        else if (previousCtrlD) previousCtrlD();
        else ctx.shutdown();
      };
      return editor;
    };
    ctx.ui.setEditorComponent(installedFactory);
  };

  pi.on("session_start", async (_event, ctx) => {
    const startGeneration = ++generation;
    if (environment.PI_ENV_SESSION_MANAGER_ROLE === "coordinator") {
      if (ctx.mode === "tui") installEditor(ctx, true);
      return;
    }
    try {
      const result = await queue(() => run(lifecycle.start(startInput(pi, ctx, environment))));
      if (result.state === "unmanaged") return;
      if (startGeneration !== generation) {
        await queue(() =>
          run(host.releaseCurrent(result.session.paneId, result.session.record.sessionId)),
        );
        return;
      }
      managed = result.session;
      if (pi.getSessionName() !== result.session.record.name) {
        syncingName = true;
        pi.setSessionName(result.session.record.name);
        syncingName = false;
      }
      installEditor(ctx, false);
      ctx.ui.setStatus("session-manager", `session: ${result.session.record.name}`);
    } catch (error) {
      if (startGeneration !== generation) {
        if (error instanceof SessionBindingFailed) {
          await queue(() =>
            run(host.releaseCurrent(error.session.paneId, error.session.record.sessionId)),
          ).catch(() => undefined);
        }
        return;
      }
      if (error instanceof SessionBindingFailed) {
        managed = error.session;
        if (pi.getSessionName() !== managed.record.name) {
          syncingName = true;
          pi.setSessionName(managed.record.name);
          syncingName = false;
        }
        installEditor(ctx, false);
      }
      notifyError(ctx, "Session enrollment", error);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!managed) return;
    const targetGeneration = generation;
    try {
      const target = managed;
      const refreshed = await queue(() =>
        run(lifecycle.refreshMaterialization(target, ctx.sessionManager.getSessionFile())),
      );
      if (
        targetGeneration === generation &&
        target.record.sessionId === managed?.record.sessionId
      ) {
        managed = refreshed;
      }
    } catch (error) {
      if (targetGeneration === generation) notifyError(ctx, "Session materialization", error);
    }
  });

  pi.on("session_info_changed", async (event, ctx) => {
    if (!managed || syncingName || event.name === managed.record.name) return;
    if (!event.name) {
      syncingName = true;
      pi.setSessionName(managed.record.name);
      syncingName = false;
      ctx.ui.notify("Managed sessions must have a name. The stable name was restored.", "warning");
      return;
    }
    const target = managed;
    const name = event.name;
    const previousName = target.record.name;
    try {
      const renamed = await queue(() => run(lifecycle.rename(target, name)));
      if (target.record.sessionId !== managed?.record.sessionId) return;
      managed = renamed;
      ctx.ui.setStatus("session-manager", `session: ${managed.record.name}`);
    } catch (error) {
      if (target.record.sessionId !== managed?.record.sessionId) return;
      if (error instanceof SessionWindowSyncFailed) {
        managed = error.session;
        notifyError(ctx, "Tmux window rename", error.cause);
        return;
      }
      syncingName = true;
      pi.setSessionName(previousName);
      syncingName = false;
      notifyError(ctx, "Session rename", error);
    }
  });

  pi.registerCommand("session-adopt", {
    description: "Adopt the current materialized Pi session into this workspace",
    handler: async (_args, ctx) => {
      try {
        managed = await queue(() => run(lifecycle.adopt(startInput(pi, ctx, environment))));
        if (pi.getSessionName() !== managed.record.name) {
          syncingName = true;
          pi.setSessionName(managed.record.name);
          syncingName = false;
        }
        if (!installedFactory && ctx.mode === "tui") installEditor(ctx, false);
        ctx.ui.setStatus("session-manager", `session: ${managed.record.name}`);
        ctx.ui.notify(`Session adopted as ${managed.record.name}.`, "info");
      } catch (error) {
        if (error instanceof SessionBindingFailed) {
          managed = error.session;
          if (pi.getSessionName() !== managed.record.name) {
            syncingName = true;
            pi.setSessionName(managed.record.name);
            syncingName = false;
          }
          if (!installedFactory && ctx.mode === "tui") installEditor(ctx, false);
          ctx.ui.setStatus("session-manager", `session: ${managed.record.name}`);
        }
        notifyError(ctx, "Session adoption", error);
      }
    },
  });

  pi.registerCommand("session-done", {
    description: "Close this work session and shut down Pi",
    handler: async (_args, ctx) => {
      if (!managed) {
        ctx.ui.notify("The current session is not an open managed work session.", "warning");
        return;
      }
      finalize(ctx, CloseSource.SessionDone);
    },
  });

  pi.registerCommand("session-status", {
    description: "Show the current workspace session status",
    handler: async (_args, ctx) => {
      try {
        if (managed) {
          const target = managed;
          const refreshed = await queue(() =>
            run(lifecycle.refreshMaterialization(target, ctx.sessionManager.getSessionFile())),
          );
          if (target.record.sessionId === managed?.record.sessionId) managed = refreshed;
        }
        const status = await run(lifecycle.status(ctx.cwd, ctx.sessionManager.getSessionId()));
        const current = status.current
          ? `${status.current.name} ${status.current.persistence.state}`
          : "unmanaged";
        ctx.ui.notify(
          `Session ${current}. Workspace: ${status.open} open, ${status.closed} closed. Revision ${status.revision}.`,
          "info",
        );
      } catch (error) {
        notifyError(ctx, "Session status", error);
      }
    },
  });

  pi.on("session_shutdown", async (event, ctx) => {
    generation += 1;
    const target = managed;
    if (
      target &&
      (event.reason === "new" || event.reason === "resume" || event.reason === "fork")
    ) {
      try {
        await queue(() => run(host.releaseCurrent(target.paneId, target.record.sessionId)));
      } catch (error) {
        notifyError(ctx, "Tmux window release", error);
      }
    }
    ctx.ui.setStatus("session-manager", undefined);
    if (installedFactory && ctx.ui.getEditorComponent() === installedFactory) {
      ctx.ui.setEditorComponent(previousFactory);
    }
    installedFactory = undefined;
    previousFactory = undefined;
    managed = undefined;
  });
}

export default async function sessionManager(pi: ExtensionAPI): Promise<void> {
  const runtimeLayer = Layer.merge(
    sessionCatalogLayer(getAgentDir()),
    tmuxSessionHostLayer((command, args) => pi.exec(command, args)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      registerSessionManager(pi, {
        catalog: yield* SessionCatalog,
        host: yield* SessionHost,
      });
    }).pipe(Effect.provide(runtimeLayer)),
  );
}

export {
  SessionCatalog,
  makeSessionCatalog,
  manifestPathForCanonicalCwd,
  nodeStorage,
  sessionCatalogLayer,
} from "./storage.js";
export { SessionManifestSchema, canonicalJson, gcTombstones, validateManifest } from "./schema.js";
export * from "./contracts.js";
export * from "./domain.js";
export * from "./host.js";
export * from "./lifecycle.js";
export * from "./session-file.js";
export type { SessionCatalogShape, StorageAdapter } from "./storage.js";
