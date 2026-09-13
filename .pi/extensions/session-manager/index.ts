import {
  CustomEditor,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { readFile, unlink } from "node:fs/promises";
import { Effect, Exit, Layer, Schedule, Scope } from "effect";
import { createWorkspaceReconciler, renderRestoreSummary } from "./coordinator.js";
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
import {
  RuntimeBusFailure,
  RuntimeMethod,
  runtimeRequest,
  startRuntimeBus,
  type RuntimeBusServer,
} from "./runtime-bus.js";
import { resolveRuntimePaths, workspaceId } from "./runtime-path.js";
import { nodeSessionFileProbe, type SessionFileProbe } from "./session-file.js";
import { SessionCatalog, sessionCatalogLayer, type SessionCatalogShape } from "./storage.js";

type Environment = Readonly<Record<string, string | undefined>>;
type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;
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

type StartupClaim = {
  readonly workspaceId?: string;
  readonly coordinatorSessionId?: string;
  readonly launchId?: string;
  readonly pid?: number;
};

function validateStartupClaim(
  claim: StartupClaim,
  workspaceId: string,
  coordinatorSessionId: string,
  launchId: string,
): void {
  if (
    claim.workspaceId !== workspaceId ||
    claim.coordinatorSessionId !== coordinatorSessionId ||
    claim.launchId !== launchId ||
    claim.pid !== process.pid
  ) {
    throw new Error("startup claim does not match the coordinator runtime");
  }
}

function restoreNoticeLevel(summary: {
  outcomes: readonly { state: string }[];
}): "warning" | "info" {
  return summary.outcomes.some((item) => item.state === "failed" || item.state === "timed-out")
    ? "warning"
    : "info";
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
  const sessionFiles = options.sessionFiles ?? nodeSessionFileProbe;
  const lifecycle: SessionLifecycle = createSessionLifecycle({
    catalog: options.catalog,
    host: options.host,
    sessionFiles,
    entropy: options.entropy ?? secureNameEntropy,
  });
  let managed: ManagedSession | undefined;
  let finalization: Promise<void> | undefined;
  let syncingName = false;
  let installedFactory: EditorFactory | undefined;
  let previousFactory: EditorFactory | undefined;
  let generation = 0;
  let transitions: Promise<void> = Promise.resolve();
  let runtimeBus: RuntimeBusServer | undefined;
  let readinessScope: Scope.Closeable | undefined;
  let coordinatorBinding: { readonly paneId: string; readonly sessionId: string } | undefined;

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
      .then(async () => {
        if (targetGeneration !== generation) return;
        await run(host.releaseCurrent(target.paneId, target.record.sessionId)).catch((error) =>
          notifyError(ctx, "Tmux window release", error),
        );
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

  const coordinatorLaunch = (ctx: ExtensionContext, expectedWorkspace: string) => {
    const paneId = environment.TMUX_PANE;
    const expectedSessionId = environment.PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID;
    if (ctx.mode !== "tui" || !paneId) {
      throw new Error("managed coordinator requires an interactive tmux session");
    }
    if (
      environment.PI_ENV_SESSION_MANAGER_EXPECTED !== "1" ||
      environment.PI_ENV_SESSION_MANAGER_WORKSPACE_ID !== expectedWorkspace ||
      expectedSessionId !== ctx.sessionManager.getSessionId()
    ) {
      throw new Error("managed coordinator launch identity does not match");
    }
    const extensionPath = environment.PI_ENV_SESSION_MANAGER_EXTENSION;
    const wrapperPath = environment.PI_ENV_PI_WRAPPER;
    if (!extensionPath || !wrapperPath) throw new Error("managed launch paths are missing");
    return { paneId, expectedSessionId, extensionPath, wrapperPath };
  };

  const startCoordinatorSession = async (ctx: ExtensionContext) => {
    try {
      const identity = await run(options.catalog.identity(ctx.cwd));
      const expectedWorkspace = workspaceId(identity.canonicalCwd);
      const { paneId, expectedSessionId, extensionPath, wrapperPath } = coordinatorLaunch(
        ctx,
        expectedWorkspace,
      );
      const manifest = await run(options.catalog.read(identity.canonicalCwd));
      if (!manifest?.coordinator || manifest.coordinator.sessionId !== expectedSessionId) {
        throw new Error("durable coordinator identity does not match");
      }
      if (host.prepareWorkspace) {
        await run(host.prepareWorkspace(paneId, identity.canonicalCwd));
      }
      await run(
        host.bindCurrent(paneId, manifest.coordinator.sessionId, manifest.coordinator.name),
      );
      coordinatorBinding = { paneId, sessionId: manifest.coordinator.sessionId };
      if (pi.getSessionName() !== manifest.coordinator.name) {
        pi.setSessionName(manifest.coordinator.name);
      }
      const paths = await run(resolveRuntimePaths(identity.canonicalCwd, environment));
      const reconciler = createWorkspaceReconciler({
        catalog: options.catalog,
        host,
        paneId,
        cwd: identity.canonicalCwd,
        workspaceId: expectedWorkspace,
        coordinatorSessionId: manifest.coordinator.sessionId,
        wrapperPath,
        extensionPath,
        sessionFiles,
      });
      runtimeBus = await run(
        startRuntimeBus({
          paths,
          workspaceId: expectedWorkspace,
          coordinatorSessionId: manifest.coordinator.sessionId,
          handlers: reconciler,
        }),
      );
      const launchId = environment.PI_ENV_SESSION_MANAGER_LAUNCH_ID;
      if (launchId) {
        const claim = JSON.parse(await readFile(paths.claimPath, "utf8")) as StartupClaim;
        validateStartupClaim(claim, expectedWorkspace, manifest.coordinator.sessionId, launchId);
        await unlink(paths.claimPath);
      }
      installEditor(ctx, true);
      const summary = await reconciler.reconcile();
      ctx.ui.notify(renderRestoreSummary(summary), restoreNoticeLevel(summary));
    } catch (error) {
      await runtimeBus?.close().catch(() => undefined);
      runtimeBus = undefined;
      notifyError(ctx, "Workspace coordinator startup", error);
      ctx.shutdown();
    }
  };

  const publishChildReady = async (session: ManagedSession, role?: string) => {
    if (environment.PI_ENV_SESSION_MANAGER_EXPECTED !== "1") return;
    const expectedWorkspace = workspaceId(session.record.cwd);
    const coordinatorId = environment.PI_ENV_SESSION_MANAGER_COORDINATOR_ID;
    const launchId = environment.PI_ENV_SESSION_MANAGER_LAUNCH_ID;
    if (
      role !== "work" ||
      environment.PI_ENV_SESSION_MANAGER_WORKSPACE_ID !== expectedWorkspace ||
      environment.PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID !== session.record.sessionId ||
      !coordinatorId ||
      !launchId
    ) {
      throw new Error("managed child launch identity does not match");
    }
    const paths = await run(resolveRuntimePaths(session.record.cwd, environment));
    const windowId = (await run(host.inspectCurrent(session.paneId))).windowId;
    await run(
      runtimeRequest({
        socketPath: paths.socketPath,
        workspaceId: expectedWorkspace,
        coordinatorSessionId: coordinatorId,
        method: RuntimeMethod.PublishReady,
        idempotencyKey: `${session.record.sessionId}:${launchId}:${Math.floor(Date.now() / 5_000)}`,
        timeoutMs: 5_000,
        params: {
          sessionId: session.record.sessionId,
          runtimeId: `${process.pid}`,
          launchId,
          windowId,
        },
      }),
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    const startGeneration = ++generation;
    const role = environment.PI_ENV_SESSION_MANAGER_ROLE;
    if (role === "coordinator") {
      await startCoordinatorSession(ctx);
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
      await publishChildReady(result.session, role);
      if (environment.PI_ENV_SESSION_MANAGER_EXPECTED === "1" && !readinessScope) {
        readinessScope = await run(Scope.make());
        const scope = readinessScope;
        const publisher = Effect.tryPromise({
          try: async () => {
            if (managed) await publishChildReady(managed, role);
          },
          catch: (error) =>
            new RuntimeBusFailure({
              operation: "repeat publish-ready",
              reason: errorMessage(error),
            }),
        }).pipe(
          Effect.catch(() => Effect.void),
          Effect.repeat(Schedule.spaced("5 seconds")),
          Effect.asVoid,
        );
        await run(publisher.pipe(Effect.forkIn(scope)));
      }
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
      if (environment.PI_ENV_SESSION_MANAGER_EXPECTED === "1") ctx.shutdown();
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (environment.PI_ENV_SESSION_MANAGER_ROLE === "coordinator") {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return;
      try {
        const identity = await run(options.catalog.identity(ctx.cwd));
        const exists = await run(sessionFiles.exists(sessionFile));
        if (!exists) return;
        await run(
          sessionFiles.verify(
            sessionFile,
            ctx.sessionManager.getSessionId(),
            identity.canonicalCwd,
          ),
        );
        await queue(() =>
          run(
            options.catalog.update(identity.canonicalCwd, (manifest) => {
              if (manifest.coordinator?.sessionId !== ctx.sessionManager.getSessionId()) {
                throw new Error("durable coordinator identity does not match");
              }
              if (manifest.coordinator.persistence.state === "materialized") return manifest;
              return {
                ...manifest,
                coordinator: {
                  ...manifest.coordinator,
                  persistence: { state: "materialized", sessionFile },
                },
              };
            }),
          ),
        );
      } catch (error) {
        notifyError(ctx, "Coordinator materialization", error);
      }
      return;
    }
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

  pi.on("session_shutdown", async (_event, ctx) => {
    generation += 1;
    if (readinessScope) await run(Scope.close(readinessScope, Exit.void));
    readinessScope = undefined;
    await runtimeBus?.close().catch(() => undefined);
    runtimeBus = undefined;
    if (coordinatorBinding) {
      const binding = coordinatorBinding;
      try {
        await queue(() => run(host.releaseCurrent(binding.paneId, binding.sessionId)));
      } catch (error) {
        notifyError(ctx, "Coordinator window release", error);
      }
      coordinatorBinding = undefined;
    }
    const target = managed;
    if (target) {
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
export * from "./coordinator.js";
export * from "./domain.js";
export * from "./host.js";
export * from "./lifecycle.js";
export * from "./runtime-bus.js";
export * from "./runtime-path.js";
export * from "./session-file.js";
export type { SessionCatalogShape, StorageAdapter } from "./storage.js";
