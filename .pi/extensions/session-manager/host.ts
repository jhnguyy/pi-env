import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Data, Effect } from "effect";

export type ExecResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};
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
export class OrphanWindowCreated extends Data.TaggedError("OrphanWindowCreated")<{
  sessionId: string;
  windowId: string;
  reason: string;
}> {}
export type SessionHostError =
  | SessionHostFailure
  | WindowBindingConflict
  | DuplicateWindowBinding
  | OrphanWindowCreated;

export type CurrentWindow = {
  readonly socketPath: string;
  readonly tmuxSessionId: string;
  readonly windowId: string;
  readonly boundSessionId?: string;
  readonly bindings: readonly { readonly windowId: string; readonly sessionId: string }[];
};

export type RestoreWindowInput = {
  readonly paneId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly cwd: string;
  readonly wrapperPath: string;
  readonly extensionPath: string;
  readonly workspaceId: string;
  readonly coordinatorSessionId: string;
  readonly launchId: string;
  readonly persistence:
    | { readonly state: "pending" }
    | { readonly state: "materialized"; readonly sessionFile: string };
};
export type RestoredWindow = {
  readonly state: "existing" | "created";
  readonly windowId: string;
};

export interface SessionHostShape {
  readonly inspectCurrent: (paneId: string) => Effect.Effect<CurrentWindow, SessionHostFailure>;
  readonly prepareWorkspace?: (
    paneId: string,
    canonicalCwd: string,
  ) => Effect.Effect<CurrentWindow, SessionHostFailure>;
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
  readonly restoreWindow?: (
    input: RestoreWindowInput,
  ) => Effect.Effect<RestoredWindow, SessionHostError>;
}

const text = (result: ExecResult) => (result.stderr || result.stdout).trim();

function workspaceSessionName(canonicalCwd: string): string {
  const hash = createHash("sha256").update(canonicalCwd, "utf8").digest("hex").slice(0, 8);
  const slug =
    basename(canonicalCwd)
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const suffix = `-${hash}`;
  return `pi-${slug.slice(0, 80 - Buffer.byteLength(`pi-${suffix}`, "ascii"))}${suffix}`;
}

export function createTmuxSessionHost(exec: Exec): SessionHostShape {
  const run = (operation: string, args: string[]) =>
    Effect.tryPromise({
      try: () => exec("tmux", args),
      catch: (cause) =>
        new SessionHostFailure({
          operation,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout.trim())
          : Effect.fail(
              new SessionHostFailure({ operation, reason: text(result) || "tmux failed" }),
            ),
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
      const boundSessionId =
        tagged.find((entry) => entry.windowId === windowId)?.sessionId || undefined;
      return {
        socketPath,
        tmuxSessionId,
        windowId,
        boundSessionId,
        bindings: tagged.filter((entry) => entry.sessionId.length > 0),
      };
    });

  const prepareWorkspace = (paneId: string, canonicalCwd: string) =>
    Effect.gen(function* () {
      const current = yield* inspectCurrent(paneId);
      const sessionIds = (yield* run("list tmux sessions", [
        "-S",
        current.socketPath,
        "list-sessions",
        "-F",
        "#{session_id}",
      ]))
        .split("\n")
        .filter(Boolean);
      if (sessionIds.length === 1 && sessionIds[0] === current.tmuxSessionId) {
        yield* run("rename workspace session", [
          "-S",
          current.socketPath,
          "rename-session",
          "-t",
          current.tmuxSessionId,
          workspaceSessionName(canonicalCwd),
        ]);
      }
      return current;
    });

  const assertBinding = (
    window: CurrentWindow,
    sessionId: string,
  ): Effect.Effect<void, SessionHostError> => {
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

  const restoreWindow = (input: RestoreWindowInput) =>
    Effect.gen(function* () {
      const current = yield* inspectCurrent(input.paneId);
      const matches = current.bindings.filter((entry) => entry.sessionId === input.sessionId);
      if (matches.length > 1) {
        return yield* new DuplicateWindowBinding({
          sessionId: input.sessionId,
          windowIds: matches.map((entry) => entry.windowId),
        });
      }
      if (matches[0]) return { state: "existing", windowId: matches[0].windowId } as const;
      const sessionArgs =
        input.persistence.state === "materialized"
          ? ["--session", input.persistence.sessionFile]
          : ["--session-id", input.sessionId, "--name", input.name];
      const args = [
        "-S",
        current.socketPath,
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        `${current.tmuxSessionId}:`,
        "-n",
        input.name,
        "-c",
        input.cwd,
        "-e",
        "PI_ENV_SESSION_MANAGER_EXPECTED=1",
        "-e",
        "PI_ENV_SESSION_MANAGER_ROLE=work",
        "-e",
        `PI_ENV_SESSION_MANAGER_WORKSPACE_ID=${input.workspaceId}`,
        "-e",
        `PI_ENV_SESSION_MANAGER_COORDINATOR_ID=${input.coordinatorSessionId}`,
        "-e",
        `PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID=${input.sessionId}`,
        "-e",
        `PI_ENV_SESSION_MANAGER_LAUNCH_ID=${input.launchId}`,
        "-e",
        `PI_ENV_SESSION_MANAGER_EXTENSION=${input.extensionPath}`,
        "--",
        input.wrapperPath,
        ...sessionArgs,
        "--extension",
        input.extensionPath,
      ];
      const windowId = yield* run("create detached window", args);
      yield* run("tag restored window", [
        "-S",
        current.socketPath,
        "set-option",
        "-w",
        "-o",
        "-t",
        windowId,
        "@pi_session_id",
        input.sessionId,
      ]).pipe(
        Effect.catch((error) =>
          run("inspect raced restored window binding", [
            "-S",
            current.socketPath,
            "show-options",
            "-w",
            "-q",
            "-v",
            "-t",
            windowId,
            "@pi_session_id",
          ]).pipe(
            Effect.flatMap((existing) =>
              existing === input.sessionId
                ? Effect.void
                : Effect.fail(
                    new OrphanWindowCreated({
                      sessionId: input.sessionId,
                      windowId,
                      reason: error.reason,
                    }),
                  ),
            ),
          ),
        ),
      );
      yield* run("disable restored window automatic rename", [
        "-S",
        current.socketPath,
        "set-option",
        "-w",
        "-t",
        windowId,
        "automatic-rename",
        "off",
      ]);
      const verified = yield* run("verify restored window binding", [
        "-S",
        current.socketPath,
        "show-options",
        "-w",
        "-q",
        "-v",
        "-t",
        windowId,
        "@pi_session_id",
      ]);
      if (verified !== input.sessionId) {
        return yield* new OrphanWindowCreated({
          sessionId: input.sessionId,
          windowId,
          reason: "tmux did not preserve the session ID tag",
        });
      }
      return { state: "created", windowId } as const;
    });

  return {
    inspectCurrent,
    prepareWorkspace,
    bindCurrent,
    renameCurrent,
    releaseCurrent,
    restoreWindow,
  };
}
