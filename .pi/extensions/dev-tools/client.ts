/**
 * LSP Client — persistent Unix socket client with daemon spawn-on-demand.
 *
 * Responsibilities:
 * - Connect to the daemon socket (auto-spawn if not running)
 * - Send JSON-over-newline requests, receive responses
 * - Handle ECONNREFUSED / ENOENT (stale socket → remove + respawn)
 * - Timeout individual requests (15s default)
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";
import { Data, Deferred, Duration, Effect, Fiber, Schedule } from "effect";
import { resolveNodeCommand } from "../../../src/process/platform.js";
import {
  parseResponse,
  serializeRequest,
  SOCKET_PATH,
  type DaemonRequest,
  type DaemonResponse,
  type LspResult,
} from "./protocol";
import { removeStaleArtifact } from "./socket-artifacts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SPAWN_RETRY_INTERVAL_MS = 200;
const SPAWN_RETRY_MAX_MS = 10_000;
const SPAWN_RETRY_MAX_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SOCKET_LISTENER_COUNT = 3;

export class ClientClosedError extends Data.TaggedError("ClientClosedError")<{
  readonly message: string;
}> {}

export class ConnectionUnavailableError extends Data.TaggedError("ConnectionUnavailableError")<{
  readonly message: string;
}> {}

export class RequestTimeoutError extends Data.TaggedError("RequestTimeoutError")<{
  readonly action: DaemonRequest["action"];
  readonly message: string;
}> {}

export class ClientTransportError extends Data.TaggedError("ClientTransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DaemonCallError extends Data.TaggedError("DaemonCallError")<{
  readonly message: string;
}> {}

export type LspClientError =
  | ClientClosedError
  | ConnectionUnavailableError
  | RequestTimeoutError
  | ClientTransportError;

export type LspCallError = LspClientError | DaemonCallError;

type PendingRequest = {
  readonly deferred: Deferred.Deferred<DaemonResponse, LspClientError>;
};

type RegisteredRequest = {
  readonly id: number;
  readonly deferred: Deferred.Deferred<DaemonResponse, LspClientError>;
};

type ConnectionAttempt = {
  readonly deferred: Deferred.Deferred<void, LspClientError>;
  fiber: Fiber.Fiber<void> | null;
};

export interface LspClientDependencies {
  readonly socketExists: (socketPath: string) => boolean;
  readonly connect: (socketPath: string) => Socket;
  readonly removeStaleArtifact: (socketPath: string) => boolean;
  readonly spawnDaemon: (nodeBinary: string, daemonScript: string) => ChildProcess;
}

const defaultDependencies: LspClientDependencies = {
  socketExists: existsSync,
  connect,
  removeStaleArtifact,
  spawnDaemon: (nodeBinary, daemonScript) =>
    spawn(nodeBinary, [daemonScript], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    }),
};

function asClientError(cause: unknown): LspClientError {
  if (
    cause instanceof ClientClosedError ||
    cause instanceof ConnectionUnavailableError ||
    cause instanceof RequestTimeoutError ||
    cause instanceof ClientTransportError
  ) {
    return cause;
  }
  return new ClientTransportError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

/**
 * Resolve the Node executable used for the detached daemon.
 *
 * Nix-managed pi can run Node through its dynamic loader. In that case
 * process.execPath is the loader itself, so spawning it with a JavaScript file
 * silently fails. Setup supplies PI_ENV_NODE_BIN as the reusable Node wrapper.
 */
export function resolveDaemonNodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return resolveNodeCommand(env, process.execPath);
}

// ─── LspClient ────────────────────────────────────────────────────────────────

export class LspClient {
  private socket: Socket | null = null;
  private socketCleanup: (() => void) | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private buf = "";
  private connectionAttempt: ConnectionAttempt | null = null;
  private connectionWaiters = 0;
  private activeRequestTimers = 0;
  private activeSocketListeners = 0;
  private closed = false;
  private readonly dependencies: LspClientDependencies;

  constructor(
    private socketPath = SOCKET_PATH,
    private daemonScript = resolve(__dirname, "daemon.js"),
    dependencies: Partial<LspClientDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  /** Number of requests currently awaiting a daemon response. */
  get pendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /** Number of callers currently awaiting the shared connection attempt. */
  get connectionWaiterCount(): number {
    return this.connectionWaiters;
  }

  /** Number of active Effect-owned request timeout scopes. */
  get activeRequestTimerCount(): number {
    return this.activeRequestTimers;
  }

  /** Number of listeners owned by the active daemon socket. */
  get socketListenerCount(): number {
    return this.activeSocketListeners;
  }

  /** Send a request to the daemon, auto-spawning if needed. */
  requestEffect(req: Omit<DaemonRequest, "id">): Effect.Effect<DaemonResponse, LspClientError> {
    const client = this;
    // A first timeout retries in isolation. Only a second timeout declares the
    // shared socket stale, because tearing it down sooner would cancel peers.
    return this.doRequestEffect(req).pipe(
      Effect.catchTag("RequestTimeoutError", () => client.doRequestEffect(req)),
      Effect.catchTag("RequestTimeoutError", (error) =>
        Effect.sync(() => client.discardStaleSocket(error)).pipe(
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
  }

  /** Promise compatibility adapter for requestEffect. */
  request(req: Omit<DaemonRequest, "id">): Promise<DaemonResponse> {
    return Effect.runPromise(this.requestEffect(req));
  }

  /** Send an action and unwrap the result or fail on a daemon error response. */
  callEffect(req: Omit<DaemonRequest, "id">): Effect.Effect<LspResult, LspCallError> {
    return this.requestEffect(req).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed(response.result!)
          : Effect.fail(new DaemonCallError({ message: response.error ?? "LSP error" })),
      ),
    );
  }

  /** Promise compatibility adapter for callEffect. */
  call(req: Omit<DaemonRequest, "id">): Promise<LspResult> {
    return Effect.runPromise(this.callEffect(req));
  }

  /** Close the socket connection. Does not shut down a successfully spawned daemon. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    const closeError = new ClientClosedError({ message: "Client closed" });
    const attempt = this.connectionAttempt;
    this.connectionAttempt = null;
    if (attempt) {
      Effect.runSync(Deferred.fail(attempt.deferred, closeError));
      attempt.fiber?.interruptUnsafe();
    }

    if (this.socket) {
      this.teardownSocket(this.socket, closeError, true);
    } else {
      this.settlePending(closeError);
    }
  }

  // ─── Request lifecycle ───────────────────────────────────────────────────

  private doRequestEffect(
    req: Omit<DaemonRequest, "id">,
  ): Effect.Effect<DaemonResponse, LspClientError> {
    const client = this;
    return Effect.gen(function* () {
      yield* client.ensureConnectedEffect();
      yield* client.assertOpenEffect();

      return yield* Effect.acquireUseRelease(
        client.registerRequestEffect(req),
        ({ deferred }) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              client.activeRequestTimers++;
            }),
            () =>
              Deferred.await(deferred).pipe(
                Effect.timeoutOrElse({
                  duration: REQUEST_TIMEOUT_MS,
                  orElse: () =>
                    Effect.fail(
                      new RequestTimeoutError({
                        action: req.action,
                        message: `LSP request timed out: ${req.action}`,
                      }),
                    ),
                }),
              ),
            () =>
              Effect.sync(() => {
                client.activeRequestTimers--;
              }),
          ),
        ({ id, deferred }) =>
          Effect.sync(() => {
            const pending = client.pendingRequests.get(id);
            if (pending?.deferred === deferred) client.pendingRequests.delete(id);
          }),
      );
    });
  }

  private registerRequestEffect(
    req: Omit<DaemonRequest, "id">,
  ): Effect.Effect<RegisteredRequest, LspClientError> {
    const client = this;
    return Effect.gen(function* () {
      const deferred = yield* Deferred.make<DaemonResponse, LspClientError>();
      return yield* Effect.try({
        try: () => {
          client.assertOpen();
          const socket = client.socket;
          if (!socket || socket.destroyed) {
            throw new ClientTransportError({ message: "Socket closed" });
          }

          const id = client.nextId++;
          client.pendingRequests.set(id, { deferred });
          try {
            socket.write(serializeRequest({ id, ...req }));
          } catch (cause) {
            client.pendingRequests.delete(id);
            throw cause;
          }
          return { id, deferred };
        },
        catch: asClientError,
      });
    });
  }

  // ─── Connection management ───────────────────────────────────────────────

  private ensureConnectedEffect(): Effect.Effect<void, LspClientError> {
    const client = this;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* client.assertOpenEffect();
        if (client.socket && !client.socket.destroyed) return;

        const candidate = yield* Deferred.make<void, LspClientError>();
        const selected = yield* Effect.sync(() => {
          if (client.connectionAttempt) {
            return { attempt: client.connectionAttempt, shouldStart: false };
          }
          const attempt: ConnectionAttempt = { deferred: candidate, fiber: null };
          client.connectionAttempt = attempt;
          return { attempt, shouldStart: true };
        });

        if (selected.shouldStart) {
          const attempt = selected.attempt;
          const fiber = yield* client
            .runConnectionAttempt(attempt)
            .pipe(Effect.forkDetach({ startImmediately: true }));
          yield* Effect.sync(() => {
            attempt.fiber = fiber;
            if (client.closed) fiber.interruptUnsafe();
          });
        }

        yield* restore(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              client.connectionWaiters++;
              return selected.attempt.deferred;
            }),
            Deferred.await,
            () =>
              Effect.sync(() => {
                client.connectionWaiters--;
              }),
          ),
        );
        yield* client.assertOpenEffect();
      }),
    );
  }

  private runConnectionAttempt(attempt: ConnectionAttempt): Effect.Effect<void> {
    const client = this;
    const clearAttempt = Effect.sync(() => {
      if (client.connectionAttempt === attempt) client.connectionAttempt = null;
    });
    return client.doConnectEffect().pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        clearAttempt.pipe(Effect.andThen(Deferred.done(attempt.deferred, exit))),
      ),
      Effect.asVoid,
      Effect.ensuring(clearAttempt),
    );
  }

  private doConnectEffect(): Effect.Effect<void, LspClientError> {
    const client = this;
    return Effect.gen(function* () {
      const connected = yield* client.tryConnectEffect();
      yield* client.assertOpenEffect();
      if (connected) return;

      client.dependencies.removeStaleArtifact(client.socketPath);
      yield* client.spawnDaemonEffect();
      yield* client.assertOpenEffect();

      const connectOnce = Effect.gen(function* () {
        const ok = yield* client.tryConnectEffect();
        yield* client.assertOpenEffect();
        if (!ok) {
          return yield* new ConnectionUnavailableError({
            message: "LSP daemon socket is not ready",
          });
        }
      });

      const retrySchedule = Schedule.exponential(SPAWN_RETRY_INTERVAL_MS, 1.5).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.millis(SPAWN_RETRY_MAX_INTERVAL_MS))),
        ),
        Schedule.upTo({ duration: SPAWN_RETRY_MAX_MS }),
      );

      yield* connectOnce.pipe(
        Effect.retry(retrySchedule),
        Effect.catchTag("ConnectionUnavailableError", () =>
          Effect.fail(
            new ConnectionUnavailableError({
              message: `Failed to connect to LSP daemon after ${SPAWN_RETRY_MAX_MS}ms`,
            }),
          ),
        ),
      );
    });
  }

  private tryConnectEffect(): Effect.Effect<boolean, LspClientError> {
    const client = this;
    return Effect.try({
      try: () => client.dependencies.socketExists(client.socketPath),
      catch: asClientError,
    }).pipe(
      Effect.flatMap((exists) => {
        if (!exists) return Effect.succeed(false);

        return Effect.callback<boolean, LspClientError>((resume) => {
          let socket: Socket;
          try {
            socket = client.dependencies.connect(client.socketPath);
          } catch (cause) {
            resume(Effect.fail(asClientError(cause)));
            return;
          }

          let settled = false;
          const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("error", onError);
          };
          const complete = (effect: Effect.Effect<boolean, LspClientError>) => {
            if (settled) return;
            settled = true;
            cleanup();
            resume(effect);
          };
          const onConnect = () => {
            if (client.closed) {
              socket.destroy();
              complete(Effect.fail(new ClientClosedError({ message: "Client closed" })));
              return;
            }
            try {
              client.setupSocket(socket);
              complete(Effect.succeed(true));
            } catch (cause) {
              socket.destroy();
              complete(Effect.fail(asClientError(cause)));
            }
          };
          const onError = () => {
            complete(Effect.succeed(false));
            if (!socket.destroyed) socket.destroy();
          };

          socket.once("connect", onConnect);
          socket.once("error", onError);

          return Effect.sync(() => {
            if (settled) return;
            settled = true;
            cleanup();
            socket.destroy();
          });
        });
      }),
    );
  }

  private spawnDaemonEffect(): Effect.Effect<void, LspClientError> {
    const client = this;
    return Effect.callback<void, LspClientError>((resume) => {
      let child: ChildProcess;
      try {
        child = client.dependencies.spawnDaemon(resolveDaemonNodeBinary(), client.daemonScript);
      } catch (cause) {
        resume(Effect.fail(asClientError(cause)));
        return;
      }

      let settled = false;
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        cleanup();
        child.unref();
        resume(Effect.void);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(Effect.fail(asClientError(error)));
      };

      child.once("spawn", onSpawn);
      child.once("error", onError);

      return Effect.sync(() => {
        if (settled) return;
        settled = true;
        cleanup();

        const onInterruptedSpawn = () => {
          child.off("error", onInterruptedError);
          child.unref();
        };
        const onInterruptedError = () => {
          child.off("spawn", onInterruptedSpawn);
        };
        child.once("spawn", onInterruptedSpawn);
        child.once("error", onInterruptedError);
      });
    });
  }

  private assertOpenEffect(): Effect.Effect<void, ClientClosedError> {
    return this.closed
      ? Effect.fail(new ClientClosedError({ message: "Client closed" }))
      : Effect.void;
  }

  private assertOpen(): void {
    if (this.closed) throw new ClientClosedError({ message: "Client closed" });
  }

  // ─── Socket lifecycle ────────────────────────────────────────────────────

  private setupSocket(socket: Socket): void {
    if (this.socket && this.socket !== socket) {
      this.teardownSocket(
        this.socket,
        new ClientTransportError({ message: "Socket replaced" }),
        true,
      );
    }

    this.socket = socket;
    this.buf = "";
    socket.setEncoding("utf8");

    const onData = (chunk: string) => this.onSocketData(socket, chunk);
    const onError = (error: Error) => this.onSocketError(socket, error);
    const onClose = () => this.onSocketClose(socket);

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    this.activeSocketListeners = SOCKET_LISTENER_COUNT;
    this.socketCleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      this.activeSocketListeners = 0;
    };
  }

  private onSocketData(socket: Socket, chunk: string): void {
    if (socket !== this.socket) return;
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = parseResponse(line);
        const pending = this.pendingRequests.get(response.id);
        if (!pending) continue;
        this.pendingRequests.delete(response.id);
        Effect.runSync(Deferred.succeed(pending.deferred, response));
      } catch {
        // Malformed responses are ignored; their request remains pending.
      }
    }
  }

  private onSocketError(socket: Socket, error: Error): void {
    this.teardownSocket(socket, asClientError(error), true);
  }

  private onSocketClose(socket: Socket): void {
    this.teardownSocket(socket, new ClientTransportError({ message: "Socket closed" }), false);
  }

  private discardStaleSocket(error: LspClientError): void {
    this.dependencies.removeStaleArtifact(this.socketPath);
    if (this.socket) this.teardownSocket(this.socket, error, true);
  }

  private teardownSocket(socket: Socket, error: LspClientError, destroy: boolean): void {
    if (socket !== this.socket) return;
    this.socketCleanup?.();
    this.socketCleanup = null;
    this.socket = null;
    this.buf = "";
    if (destroy && !socket.destroyed) socket.destroy();
    this.settlePending(error);
  }

  private settlePending(error: LspClientError): void {
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    Effect.runSync(
      Effect.forEach(pending, ({ deferred }) => Deferred.fail(deferred, error), {
        discard: true,
      }),
    );
  }
}
