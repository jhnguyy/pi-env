import { Context, Data, Effect, Layer } from "effect";

export type ExecResult = { readonly stdout: string; readonly stderr: string; readonly code: number };
export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

export class SessionHostFailure extends Data.TaggedError("SessionHostFailure")<{
  operation: string;
  reason: string;
}> {}
export class WindowBindingConflict extends Data.TaggedError("WindowBindingConflict")<{
  windowId: string;
  existingSessionId: string;
}> {}
export class DuplicateWindowBinding extends Data.TaggedError("DuplicateWindowBinding")<{
  sessionId: string;
  windowIds: readonly string[];
}> {}
export type SessionHostError = SessionHostFailure | WindowBindingConflict | DuplicateWindowBinding;

export type CurrentWindow = {
  readonly socketPath: string;
  readonly tmuxSessionId: string;
  readonly windowId: string;
  readonly boundSessionId?: string;
  readonly bindings: readonly { readonly windowId: string; readonly sessionId: string }[];
};

export interface SessionHostShape {
  readonly inspectCurrent: (paneId: string) => Effect.Effect<CurrentWindow, SessionHostFailure>;
  readonly bindCurrent: (
    paneId: string,
    sessionId: string,
    name: string,
  ) => Effect.Effect<CurrentWindow, SessionHostError>;
  readonly renameCurrent: (
    paneId: string,
    sessionId: string,
    name: string,
  ) => Effect.Effect<void, SessionHostError>;
  readonly releaseCurrent: (
    paneId: string,
    sessionId: string,
  ) => Effect.Effect<void, SessionHostError>;
}

const text = (result: ExecResult) => (result.stderr || result.stdout).trim();

export class SessionHost extends Context.Service<SessionHost, SessionHostShape>()(
  "pi/session-manager/SessionHost",
) {}

export function createTmuxSessionHost(exec: Exec): SessionHostShape {
  const run = (operation: string, args: string[]) =>
    Effect.tryPromise({
      try: () => exec("tmux", args),
      catch: (cause) =>
        new SessionHostFailure({ operation, reason: cause instanceof Error ? cause.message : String(cause) }),
    }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout.trim())
          : Effect.fail(new SessionHostFailure({ operation, reason: text(result) || "tmux failed" })),
      ),
    );

  const inspectCurrent = (paneId: string) =>
    Effect.gen(function* () {
      const socketPath = yield* run("resolve socket", [
        "display-message",
        "-p",
        "-t",
        paneId,
        "-F",
        "#{socket_path}",
      ]);
      const [tmuxSessionId, windowId] = yield* Effect.all([
        run("resolve session", [
          "-S",
          socketPath,
          "display-message",
          "-p",
          "-t",
          paneId,
          "-F",
          "#{session_id}",
        ]),
        run("resolve window", [
          "-S",
          socketPath,
          "display-message",
          "-p",
          "-t",
          paneId,
          "-F",
          "#{window_id}",
        ]),
      ]);
      const windowIds = (yield* run("list windows", [
        "-S",
        socketPath,
        "list-windows",
        "-t",
        tmuxSessionId,
        "-F",
        "#{window_id}",
      ]))
        .split("\n")
        .filter(Boolean);
      const tagged = yield* Effect.forEach(windowIds, (candidate) =>
        run("read window binding", [
          "-S",
          socketPath,
          "show-options",
          "-w",
          "-q",
          "-v",
          "-t",
          candidate,
          "@pi_session_id",
        ]).pipe(Effect.map((sessionId) => ({ windowId: candidate, sessionId }))),
      );
      const boundSessionId = tagged.find((entry) => entry.windowId === windowId)?.sessionId || undefined;
      return {
        socketPath,
        tmuxSessionId,
        windowId,
        boundSessionId,
        bindings: tagged.filter((entry) => entry.sessionId.length > 0),
      };
    });

  const assertBinding = (window: CurrentWindow, sessionId: string): Effect.Effect<void, SessionHostError> => {
    if (window.boundSessionId && window.boundSessionId !== sessionId) {
      return Effect.fail(
        new WindowBindingConflict({
          windowId: window.windowId,
          existingSessionId: window.boundSessionId,
        }),
      );
    }
    const duplicates = window.bindings
      .filter((entry) => entry.sessionId === sessionId && entry.windowId !== window.windowId)
      .map((entry) => entry.windowId);
    return duplicates.length > 0
      ? Effect.fail(
          new DuplicateWindowBinding({ sessionId, windowIds: [window.windowId, ...duplicates] }),
        )
      : Effect.void;
  };

  const bindCurrent = (paneId: string, sessionId: string, name: string) =>
    Effect.gen(function* () {
      const window = yield* inspectCurrent(paneId);
      yield* assertBinding(window, sessionId);
      if (!window.boundSessionId) {
        yield* run("create window binding", [
          "-S",
          window.socketPath,
          "set-option",
          "-w",
          "-o",
          "-t",
          window.windowId,
          "@pi_session_id",
          sessionId,
        ]);
      }
      yield* run("disable automatic rename", [
        "-S",
        window.socketPath,
        "set-option",
        "-w",
        "-t",
        window.windowId,
        "automatic-rename",
        "off",
      ]);
      yield* run("rename window", [
        "-S",
        window.socketPath,
        "rename-window",
        "-t",
        window.windowId,
        name,
      ]);
      const verified = yield* inspectCurrent(paneId);
      if (verified.boundSessionId !== sessionId) {
        return yield* new SessionHostFailure({
          operation: "verify window binding",
          reason: "tmux did not preserve the session ID tag",
        });
      }
      yield* assertBinding(verified, sessionId);
      return verified;
    });

  const renameCurrent = (paneId: string, sessionId: string, name: string) =>
    Effect.gen(function* () {
      const window = yield* inspectCurrent(paneId);
      yield* assertBinding(window, sessionId);
      if (window.boundSessionId !== sessionId) {
        return yield* new SessionHostFailure({
          operation: "rename window",
          reason: "the current window is not bound to this Pi session",
        });
      }
      yield* run("rename window", [
        "-S",
        window.socketPath,
        "rename-window",
        "-t",
        window.windowId,
        name,
      ]);
    });

  const releaseCurrent = (paneId: string, sessionId: string) =>
    Effect.gen(function* () {
      const window = yield* inspectCurrent(paneId);
      yield* assertBinding(window, sessionId);
      if (window.boundSessionId !== sessionId) return;
      yield* run("release window binding", [
        "-S",
        window.socketPath,
        "set-option",
        "-w",
        "-u",
        "-t",
        window.windowId,
        "@pi_session_id",
      ]);
    });

  return { inspectCurrent, bindCurrent, renameCurrent, releaseCurrent };
}

export function tmuxSessionHostLayer(exec: Exec): Layer.Layer<SessionHost> {
  return Layer.succeed(SessionHost, createTmuxSessionHost(exec));
}
