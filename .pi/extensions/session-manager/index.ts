import {
  CustomEditor,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { readFile, unlink } from "node:fs/promises";
import { Effect, Exit, Result, Schedule, Scope } from "effect";
import { createWorkspaceReconciler, renderRestoreSummary } from "./coordinator.js";
import { CloseSource, findRecord } from "./domain.js";
import { createTmuxSessionHost, type SessionHostShape } from "./host.js";
import {
  type CoordinatorLaunch,
  type Environment,
  type LaunchIntent,
  type RestoredWorkLaunch,
  parseLaunchIntent,
  parseStartupClaim,
} from "./launch.js";
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
import { createFileSessionCatalog, type SessionCatalogShape } from "./storage.js";

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
  paneId: string | undefined,
): SessionStartInput {
  return {
    mode: ctx.mode,
    cwd: ctx.cwd,
    paneId,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionName: pi.getSessionName(),
  };
}

function isEditorWithCtrlD(editor: ReturnType<EditorFactory>): editor is EditorWithCtrlD {
  return "actionHandlers" in editor && editor.actionHandlers instanceof Map;
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
  });
  let managed: ManagedSession | undefined;
  let finalization: Promise<void> | undefined;
  let syncingName = false;
  let displayName: string | undefined;
  let installedFactory: EditorFactory | undefined;
  let previousFactory: EditorFactory | undefined;
  let generation = 0;
  let transitions: Promise<void> = Promise.resolve();
  let runtimeBus: RuntimeBusServer | undefined;
  let readinessScope: Scope.Closeable | undefined;
  let coordinatorBinding: { readonly paneId: string; readonly sessionId: string } | undefined;
  let launchIntent: LaunchIntent | undefined;

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

  const startCoordinatorSession = async (ctx: ExtensionContext, launch: CoordinatorLaunch) => {
    try {
      const identity = await run(options.catalog.identity(ctx.cwd));
      const expectedWorkspace = workspaceId(identity.canonicalCwd);
      if (
        ctx.mode !== "tui" ||
        launch.workspaceId !== expectedWorkspace ||
        launch.expectedSessionId !== ctx.sessionManager.getSessionId()
      ) {
        throw new Error("managed coordinator launch identity does not match");
      }
      const { paneId, expectedSessionId, extensionPath, wrapperPath } = launch;
      const manifest = await run(options.catalog.read(identity.canonicalCwd));
      if (!manifest?.coordinator || manifest.coordinator.sessionId !== expectedSessionId) {
        throw new Error("durable coordinator identity does not match");
      }
      const paths = await run(resolveRuntimePaths(identity.canonicalCwd, environment));
      const parsedClaim = parseStartupClaim(await readFile(paths.claimPath, "utf8"));
      if (Result.isFailure(parsedClaim)) throw parsedClaim.failure;
      const claim = parsedClaim.success;
      if (
        claim.workspaceId !== expectedWorkspace ||
        claim.coordinatorSessionId !== manifest.coordinator.sessionId ||
        claim.launchId !== launch.launchId ||
        claim.pid !== process.pid
      ) {
        throw new Error("startup claim does not match the coordinator runtime");
      }
      await run(host.bindCurrent(paneId, manifest.coordinator.sessionId));
      coordinatorBinding = { paneId, sessionId: manifest.coordinator.sessionId };
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
      await unlink(paths.claimPath);
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

  const publishChildReady = async (session: ManagedSession, launch: RestoredWorkLaunch) => {
    const expectedWorkspace = workspaceId(session.record.cwd);
    if (
      launch.workspaceId !== expectedWorkspace ||
      launch.expectedSessionId !== session.record.sessionId
    ) {
      throw new Error("managed child launch identity does not match");
    }
    const coordinatorId = launch.coordinatorSessionId;
    const launchId = launch.launchId;
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

  type WorkLaunch = Exclude<LaunchIntent, CoordinatorLaunch>;

  const verifyRestoredWorkLaunch = async (
    ctx: ExtensionContext,
    launch: RestoredWorkLaunch,
  ): Promise<void> => {
    const identity = await run(options.catalog.identity(ctx.cwd));
    if (
      ctx.mode !== "tui" ||
      launch.workspaceId !== workspaceId(identity.canonicalCwd) ||
      launch.expectedSessionId !== ctx.sessionManager.getSessionId()
    ) {
      throw new Error("managed child launch identity does not match");
    }
    const manifest = await run(options.catalog.read(identity.canonicalCwd));
    const expectedRecord = manifest ? findRecord(manifest, launch.expectedSessionId) : undefined;
    if (
      manifest?.coordinator?.sessionId !== launch.coordinatorSessionId ||
      expectedRecord?.role !== "work" ||
      expectedRecord.desiredState !== "open"
    ) {
      throw new Error("managed child durable identity does not match");
    }
  };

  const activateManagedSession = (ctx: ExtensionContext, session: ManagedSession): void => {
    managed = session;
    installEditor(ctx, false);
  };

  const startReadinessPublisher = async (launch: RestoredWorkLaunch): Promise<void> => {
    if (readinessScope) return;
    readinessScope = await run(Scope.make());
    const publisher = Effect.tryPromise({
      try: async () => {
        if (managed) await publishChildReady(managed, launch);
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
    await run(publisher.pipe(Effect.forkIn(readinessScope)));
  };

  const releaseInterruptedBinding = async (error: unknown): Promise<void> => {
    if (!(error instanceof SessionBindingFailed)) return;
    await queue(() =>
      run(host.releaseCurrent(error.session.paneId, error.session.record.sessionId)),
    ).catch(() => undefined);
  };

  const handleEnrollmentFailure = async (
    ctx: ExtensionContext,
    launch: WorkLaunch,
    startGeneration: number,
    error: unknown,
  ): Promise<void> => {
    if (startGeneration !== generation) {
      await releaseInterruptedBinding(error);
      return;
    }
    if (error instanceof SessionBindingFailed) activateManagedSession(ctx, error.session);
    notifyError(ctx, "Session enrollment", error);
    if (launch.kind === "restored-work") ctx.shutdown();
  };

  const startWorkSession = async (
    ctx: ExtensionContext,
    launch: WorkLaunch,
    startGeneration: number,
  ): Promise<void> => {
    try {
      if (launch.kind === "restored-work") await verifyRestoredWorkLaunch(ctx, launch);
      const result = await queue(() => run(lifecycle.start(startInput(pi, ctx, launch.paneId))));
      if (result.state === "unmanaged") {
        if (launch.kind === "restored-work") {
          throw new Error(`managed child became unmanaged: ${result.reason}`);
        }
        return;
      }
      if (startGeneration !== generation) {
        await queue(() =>
          run(host.releaseCurrent(result.session.paneId, result.session.record.sessionId)),
        );
        return;
      }
      activateManagedSession(ctx, result.session);
      if (launch.kind !== "restored-work") return;
      await publishChildReady(result.session, launch);
      await startReadinessPublisher(launch);
    } catch (error) {
      await handleEnrollmentFailure(ctx, launch, startGeneration, error);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const startGeneration = ++generation;
    displayName = pi.getSessionName();
    launchIntent = undefined;
    const parsedLaunch = parseLaunchIntent(environment);
    if (Result.isFailure(parsedLaunch)) {
      notifyError(ctx, "Session launch", parsedLaunch.failure);
      ctx.shutdown();
      return;
    }
    const launch = parsedLaunch.success;
    launchIntent = launch;
    if (launch.kind === "coordinator") await startCoordinatorSession(ctx, launch);
    else await startWorkSession(ctx, launch, startGeneration);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (launchIntent?.kind === "coordinator") {
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
    if (syncingName) return;
    const previousDisplayName = displayName;
    displayName = event.name;
    if (
      !managed ||
      !event.name ||
      (event.name === managed.record.name && managed.record.explicitName)
    )
      return;
    const target = managed;
    const name = event.name;
    try {
      const renamed = await queue(() => run(lifecycle.rename(target, name)));
      if (target.record.sessionId !== managed?.record.sessionId) return;
      managed = renamed;
    } catch (error) {
      if (target.record.sessionId !== managed?.record.sessionId) return;
      if (error instanceof SessionWindowSyncFailed) {
        managed = error.session;
        notifyError(ctx, "Tmux window rename", error.cause);
        return;
      }
      syncingName = true;
      pi.setSessionName(previousDisplayName ?? "");
      syncingName = false;
      displayName = previousDisplayName;
      notifyError(ctx, "Session rename", error);
    }
  });

  pi.registerCommand("session-adopt", {
    description: "Adopt the current materialized Pi session into this workspace",
    handler: async (_args, ctx) => {
      try {
        managed = await queue(() =>
          run(lifecycle.adopt(startInput(pi, ctx, environment.TMUX_PANE))),
        );
        if (!installedFactory && ctx.mode === "tui") installEditor(ctx, false);
        ctx.ui.notify(
          `Session adopted${managed.record.name ? ` as ${managed.record.name}` : ""}.`,
          "info",
        );
      } catch (error) {
        if (error instanceof SessionBindingFailed) {
          managed = error.session;
          if (!installedFactory && ctx.mode === "tui") installEditor(ctx, false);
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
          ? `${status.current.name ?? status.current.sessionId} ${status.current.persistence.state}`
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
    if (installedFactory && ctx.ui.getEditorComponent() === installedFactory) {
      ctx.ui.setEditorComponent(previousFactory);
    }
    installedFactory = undefined;
    previousFactory = undefined;
    managed = undefined;
    launchIntent = undefined;
  });
}

export default async function sessionManager(pi: ExtensionAPI): Promise<void> {
  registerSessionManager(pi, {
    catalog: createFileSessionCatalog(getAgentDir()),
    host: createTmuxSessionHost((command, args) => pi.exec(command, args)),
  });
}
