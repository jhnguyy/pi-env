import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { it as effectIt } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  ClientTransportError,
  LspClient,
  RequestTimeoutError,
  resolveDaemonNodeBinary,
  type LspClientDependencies,
} from "../client";
import {
  errorResponse,
  okResponse,
  serializeResponse,
  type DaemonRequest,
  type StatusResult,
  type SymbolsResult,
} from "../protocol";

const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_MS = 200;

type RequestHandler = (request: DaemonRequest, socket: Socket) => void;
type FakeChild = ChildProcess & {
  readonly unref: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
};

type FakeSocket = Socket & {
  destroyed: boolean;
};

function statusResult(pid = 999): StatusResult {
  return {
    action: "status",
    running: true,
    pid,
    projects: [],
    openFiles: [],
    watchedFiles: 0,
    idleMs: 0,
  };
}

function symbolsResult(query: string): SymbolsResult {
  return {
    action: "symbols",
    query,
    total: 1,
    items: [{ line: 1, name: query, kind: "variable" }],
    truncated: false,
  };
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    unref: vi.fn(),
    kill: vi.fn(() => true),
  });
  return child;
}

function createFakeSocket(
  onWrite: (data: string, socket: FakeSocket) => void = () => {},
): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  Object.assign(socket, {
    destroyed: false,
    setEncoding: vi.fn(() => socket),
    write: vi.fn((data: string | Uint8Array) => {
      onWrite(String(data), socket);
      return true;
    }),
    destroy: vi.fn(() => {
      if (socket.destroyed) return socket;
      socket.destroyed = true;
      queueMicrotask(() => socket.emit("close"));
      return socket;
    }),
  });
  return socket;
}

function emitConnected(socket: FakeSocket): void {
  queueMicrotask(() => socket.emit("connect"));
}

function parsedRequest(data: string): DaemonRequest {
  return JSON.parse(data.trim()) as DaemonRequest;
}

function complete(deferred: Deferred.Deferred<void>): void {
  Deferred.doneUnsafe(deferred, Effect.void);
}

function waitUntil(predicate: () => boolean): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (!predicate()) yield* Effect.yieldNow;
  });
}

describeIfEnabled("dev-tools", "LspClient", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: Server | null;
  let serverConnections: number;
  let serverSockets: Set<Socket>;
  let clients: LspClient[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lsp-c-"));
    socketPath = join(tmpDir, "t.sock");
    server = null;
    serverConnections = 0;
    serverSockets = new Set();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await closeServer();
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  function track(client: LspClient): LspClient {
    clients.push(client);
    return client;
  }

  function startMockServer(handler: RequestHandler): Promise<Server> {
    return new Promise((resolve, reject) => {
      server = createServer((socket) => {
        serverConnections++;
        serverSockets.add(socket);
        socket.once("close", () => serverSockets.delete(socket));
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (data: string) => {
          buffer += data;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            handler(JSON.parse(line) as DaemonRequest, socket);
          }
        });
      });
      server.once("error", reject);
      server.listen(socketPath, () => resolve(server!));
    });
  }

  function closeServer(): Promise<void> {
    return new Promise((resolve) => {
      for (const socket of serverSockets) socket.destroy();
      serverSockets.clear();
      if (!server?.listening) {
        server = null;
        resolve();
        return;
      }
      server.close(() => resolve());
      server = null;
    });
  }

  describe("compatibility surface", () => {
    it("preserves zero/custom construction, Promise adapters, and synchronous idempotent close", async () => {
      await startMockServer((request, socket) => {
        socket.write(serializeResponse(okResponse(request.id, statusResult())));
      });

      const defaultClient = new LspClient();
      expect(defaultClient.close()).toBeUndefined();
      expect(defaultClient.close()).toBeUndefined();

      const client = track(new LspClient(socketPath, join(tmpDir, "daemon.js")));
      const request = client.request({ action: "status" });
      expect(request).toBeInstanceOf(Promise);
      expect((await request).ok).toBe(true);
      expect(await client.call({ action: "status" })).toMatchObject({ action: "status" });

      expect(client.close()).toBeUndefined();
      await expect(client.request({ action: "status" })).rejects.toThrow("Client closed");
    });

    it("rejects active Promise requests synchronously on close without a coordination sleep", async () => {
      let markWritten!: () => void;
      const written = new Promise<void>((resolve) => {
        markWritten = resolve;
      });
      await startMockServer(() => markWritten());

      const client = track(new LspClient(socketPath));
      const pending = client.request({ action: "status" });
      await written;
      expect(client.pendingRequestCount).toBe(1);

      client.close();

      await expect(pending).rejects.toThrow("Client closed");
      expect(client.pendingRequestCount).toBe(0);
      expect(client.activeRequestTimerCount).toBe(0);
      expect(client.socketListenerCount).toBe(0);
    });
  });

  describe("Effect-native request and call", () => {
    effectIt.effect("matches response and call error behavior", () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          startMockServer((request, socket) => {
            const response =
              request.query === "fail"
                ? errorResponse(request.id, "something broke")
                : okResponse(request.id, statusResult());
            socket.write(serializeResponse(response));
          }),
        );

        const client = track(new LspClient(socketPath));
        const response = yield* client.requestEffect({ action: "status" });
        expect(response.ok).toBe(true);
        expect(yield* client.callEffect({ action: "status" })).toMatchObject({
          action: "status",
        });
        const error = yield* client
          .callEffect({ action: "symbols", query: "fail" })
          .pipe(Effect.flip);
        expect(error.message).toBe("something broke");
      }),
    );
  });

  describe("request identity and response demultiplexing", () => {
    it("assigns unique IDs and resolves out-of-order responses to their callers", async () => {
      const received: Array<{ request: DaemonRequest; socket: Socket }> = [];
      await startMockServer((request, socket) => {
        received.push({ request, socket });
        if (received.length !== 3) return;
        for (const item of [...received].reverse()) {
          item.socket.write(
            serializeResponse(
              okResponse(item.request.id, symbolsResult(item.request.query ?? "missing")),
            ),
          );
        }
      });

      const client = track(new LspClient(socketPath));
      const results = await Promise.all(
        ["first", "second", "third"].map(
          (query) => client.call({ action: "symbols", query }) as Promise<SymbolsResult>,
        ),
      );

      expect(new Set(received.map(({ request }) => request.id)).size).toBe(3);
      expect(results.map((result) => result.query)).toEqual(["first", "second", "third"]);
    });
  });

  describe("shared connection and deterministic retry", () => {
    effectIt.effect("shares stale recovery and spawns exactly once for concurrent requests", () =>
      Effect.gen(function* () {
        writeFileSync(socketPath, "stale");
        const spawnStarted = yield* Deferred.make<void>();
        const child = createFakeChild();
        let spawnCalls = 0;
        let connectCalls = 0;
        const dependencies: Partial<LspClientDependencies> = {
          connect: (path) => {
            connectCalls++;
            return netConnect(path);
          },
          spawnDaemon: () => {
            spawnCalls++;
            complete(spawnStarted);
            void startMockServer((request, socket) => {
              socket.write(serializeResponse(okResponse(request.id, statusResult())));
            }).then(() => child.emit("spawn"));
            return child;
          },
        };
        const client = track(new LspClient(socketPath, join(tmpDir, "daemon.js"), dependencies));

        const requests = yield* Effect.forEach(Array.from({ length: 100 }), () =>
          client.requestEffect({ action: "status" }).pipe(Effect.forkChild),
        );
        yield* Deferred.await(spawnStarted);
        yield* Effect.forEach(requests, Fiber.join, { discard: true });

        expect(spawnCalls).toBe(1);
        expect(connectCalls).toBe(2);
        expect(serverConnections).toBe(1);
        expect(child.unref).toHaveBeenCalledTimes(1);
        expect(child.kill).not.toHaveBeenCalled();
        expect(client.connectionWaiterCount).toBe(0);
        expect(client.pendingRequestCount).toBe(0);

        client.close();
        expect(child.kill).not.toHaveBeenCalled();
      }),
    );

    effectIt.effect("uses TestClock for the connection backoff", () =>
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<void>();
        const requestWritten = yield* Deferred.make<void>();
        const child = createFakeChild();
        let available = false;
        let existenceChecks = 0;
        const socket = createFakeSocket((data, current) => {
          const request = parsedRequest(data);
          current.emit("data", serializeResponse(okResponse(request.id, statusResult())));
          complete(requestWritten);
        });
        const client = track(
          new LspClient(socketPath, join(tmpDir, "daemon.js"), {
            socketExists: () => {
              existenceChecks++;
              return available;
            },
            connect: () => {
              emitConnected(socket);
              return socket;
            },
            spawnDaemon: () => {
              queueMicrotask(() => {
                child.emit("spawn");
                complete(spawned);
              });
              return child;
            },
          }),
        );

        const request = yield* client.requestEffect({ action: "status" }).pipe(Effect.forkChild);
        yield* Deferred.await(spawned);
        yield* waitUntil(() => existenceChecks >= 2);
        const beforeBackoff = existenceChecks;
        available = true;

        yield* TestClock.adjust(CONNECT_RETRY_MS - 1);
        expect(existenceChecks).toBe(beforeBackoff);
        yield* TestClock.adjust(1);
        yield* Deferred.await(requestWritten);
        expect((yield* Fiber.join(request)).ok).toBe(true);
        expect(existenceChecks).toBe(beforeBackoff + 1);
      }),
    );
  });

  describe("interruption and timeout isolation", () => {
    effectIt.effect("interrupting one request removes only that request", () =>
      Effect.gen(function* () {
        const bothWritten = yield* Deferred.make<void>();
        const received = new Map<string, { request: DaemonRequest; socket: Socket }>();
        yield* Effect.promise(() =>
          startMockServer((request, socket) => {
            received.set(request.query!, { request, socket });
            if (received.size === 2) complete(bothWritten);
          }),
        );
        const client = track(new LspClient(socketPath));
        const interrupted = yield* client
          .requestEffect({ action: "symbols", query: "cancel" })
          .pipe(Effect.forkChild);
        const survivor = yield* client
          .requestEffect({ action: "symbols", query: "survive" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(bothWritten);
        expect(client.pendingRequestCount).toBe(2);

        yield* Fiber.interrupt(interrupted);
        expect(client.pendingRequestCount).toBe(1);
        expect(client.activeRequestTimerCount).toBe(1);

        const pending = received.get("survive")!;
        pending.socket.write(
          serializeResponse(okResponse(pending.request.id, symbolsResult("survive"))),
        );
        expect((yield* Fiber.join(survivor)).result).toMatchObject({ query: "survive" });
        expect(client.pendingRequestCount).toBe(0);
        expect(client.activeRequestTimerCount).toBe(0);
      }),
    );

    effectIt.effect("keeps unrelated requests on the original socket after a first timeout", () =>
      Effect.gen(function* () {
        const firstSlowWritten = yield* Deferred.make<void>();
        const initialWritten = yield* Deferred.make<void>();
        const retryWritten = yield* Deferred.make<void>();
        const received = new Map<string, Array<{ request: DaemonRequest; socket: Socket }>>();
        yield* Effect.promise(() =>
          startMockServer((request, socket) => {
            const entries = received.get(request.query!) ?? [];
            entries.push({ request, socket });
            received.set(request.query!, entries);
            if ((received.get("slow")?.length ?? 0) === 1) {
              complete(firstSlowWritten);
            }
            if ((received.get("slow")?.length ?? 0) === 1 && received.has("survivor")) {
              complete(initialWritten);
            }
            if ((received.get("slow")?.length ?? 0) === 2) {
              complete(retryWritten);
            }
          }),
        );
        const client = track(new LspClient(socketPath));
        const slow = yield* client
          .requestEffect({ action: "symbols", query: "slow" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstSlowWritten);
        yield* TestClock.adjust(1);
        const survivor = yield* client
          .requestEffect({ action: "symbols", query: "survivor" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(initialWritten);

        yield* TestClock.adjust(REQUEST_TIMEOUT_MS - 1);
        yield* Deferred.await(retryWritten);
        expect(serverConnections).toBe(1);
        expect(client.pendingRequestCount).toBe(2);

        const survivorRequest = received.get("survivor")![0];
        survivorRequest.socket.write(
          serializeResponse(okResponse(survivorRequest.request.id, symbolsResult("survivor"))),
        );
        const retryRequest = received.get("slow")![1];
        retryRequest.socket.write(
          serializeResponse(okResponse(retryRequest.request.id, symbolsResult("slow"))),
        );

        expect((yield* Fiber.join(survivor)).result).toMatchObject({ query: "survivor" });
        expect((yield* Fiber.join(slow)).result).toMatchObject({ query: "slow" });
        expect(client.pendingRequestCount).toBe(0);
        expect(client.activeRequestTimerCount).toBe(0);
      }),
    );

    effectIt.effect("tears down the stale socket when the retry also times out", () =>
      Effect.gen(function* () {
        const firstWritten = yield* Deferred.make<void>();
        const retryWritten = yield* Deferred.make<void>();
        const socketClosed = yield* Deferred.make<void>();
        let writes = 0;
        yield* Effect.promise(() =>
          startMockServer((_request, socket) => {
            writes++;
            complete(writes === 1 ? firstWritten : retryWritten);
            socket.once("close", () => {
              complete(socketClosed);
            });
          }),
        );
        const client = track(new LspClient(socketPath));
        const request = yield* client.requestEffect({ action: "status" }).pipe(Effect.forkChild);
        yield* Deferred.await(firstWritten);

        yield* TestClock.adjust(REQUEST_TIMEOUT_MS);
        yield* Deferred.await(retryWritten);
        expect(client.pendingRequestCount).toBe(1);
        expect(client.socketListenerCount).toBe(3);

        yield* TestClock.adjust(REQUEST_TIMEOUT_MS);
        const error = yield* Fiber.join(request).pipe(Effect.flip);
        yield* Deferred.await(socketClosed);

        expect(error).toBeInstanceOf(RequestTimeoutError);
        expect(error.message).toBe("LSP request timed out: status");
        expect(client.pendingRequestCount).toBe(0);
        expect(client.activeRequestTimerCount).toBe(0);
        expect(client.socketListenerCount).toBe(0);
        expect(serverSockets.size).toBe(0);
        expect(existsSync(socketPath)).toBe(false);
      }),
    );
  });

  describe("close and terminal socket cleanup", () => {
    effectIt.effect("close rejects active Effect requests and releases their resources", () =>
      Effect.gen(function* () {
        const bothWritten = yield* Deferred.make<void>();
        let writes = 0;
        yield* Effect.promise(() =>
          startMockServer(() => {
            writes++;
            if (writes === 2) complete(bothWritten);
          }),
        );
        const client = track(new LspClient(socketPath));
        const requests = yield* Effect.forEach(Array.from({ length: 2 }), () =>
          client.requestEffect({ action: "status" }).pipe(Effect.forkChild),
        );
        yield* Deferred.await(bothWritten);

        client.close();
        const exits = yield* Effect.forEach(requests, Fiber.await);

        expect(exits.every(Exit.isFailure)).toBe(true);
        expect(client.pendingRequestCount).toBe(0);
        expect(client.activeRequestTimerCount).toBe(0);
        expect(client.connectionWaiterCount).toBe(0);
        expect(client.socketListenerCount).toBe(0);
      }),
    );

    effectIt.effect("close during spawn preserves a daemon that later spawns successfully", () =>
      Effect.gen(function* () {
        const spawnCalled = yield* Deferred.make<void>();
        const child = createFakeChild();
        const client = track(
          new LspClient(socketPath, join(tmpDir, "daemon.js"), {
            socketExists: () => false,
            spawnDaemon: () => {
              complete(spawnCalled);
              return child;
            },
          }),
        );
        const request = yield* client.requestEffect({ action: "status" }).pipe(Effect.forkChild);
        yield* Deferred.await(spawnCalled);

        client.close();
        const error = yield* Fiber.join(request).pipe(Effect.flip);
        yield* waitUntil(() => child.listenerCount("spawn") === 1);

        expect(error.message).toBe("Client closed");
        expect(child.kill).not.toHaveBeenCalled();
        expect(child.unref).not.toHaveBeenCalled();

        child.emit("spawn");
        expect(child.unref).toHaveBeenCalledTimes(1);
        expect(child.kill).not.toHaveBeenCalled();
        expect(child.listenerCount("spawn")).toBe(0);
        expect(child.listenerCount("error")).toBe(0);
        expect(client.connectionWaiterCount).toBe(0);
      }),
    );

    effectIt.effect(
      "close rejects every shared connection waiter and removes connect listeners",
      () =>
        Effect.gen(function* () {
          const connecting = yield* Deferred.make<void>();
          const socket = createFakeSocket();
          const client = track(
            new LspClient(socketPath, join(tmpDir, "daemon.js"), {
              socketExists: () => true,
              connect: () => {
                complete(connecting);
                return socket;
              },
            }),
          );
          const requests = yield* Effect.forEach(Array.from({ length: 20 }), () =>
            client.requestEffect({ action: "status" }).pipe(Effect.forkChild),
          );
          yield* Deferred.await(connecting);
          yield* waitUntil(() => client.connectionWaiterCount === requests.length);

          client.close();
          const exits = yield* Effect.forEach(requests, Fiber.await);
          yield* waitUntil(
            () => socket.listenerCount("connect") === 0 && socket.listenerCount("error") === 0,
          );

          expect(exits.every(Exit.isFailure)).toBe(true);
          expect(client.connectionWaiterCount).toBe(0);
          expect(client.pendingRequestCount).toBe(0);
          expect(client.activeRequestTimerCount).toBe(0);
          expect(client.socketListenerCount).toBe(0);
          expect(socket.destroyed).toBe(true);
        }),
    );

    const terminalFailureProgram = (event: "error" | "close") =>
      Effect.gen(function* () {
        const bothWritten = yield* Deferred.make<void>();
        let writes = 0;
        const first = createFakeSocket(() => {
          writes++;
          if (writes === 2) complete(bothWritten);
        });
        const second = createFakeSocket((data, socket) => {
          const request = parsedRequest(data);
          queueMicrotask(() =>
            socket.emit("data", serializeResponse(okResponse(request.id, statusResult(2)))),
          );
        });
        const sockets = [first, second];
        let connectCalls = 0;
        const client = track(
          new LspClient(socketPath, join(tmpDir, "daemon.js"), {
            socketExists: () => true,
            connect: () => {
              const socket = sockets[connectCalls++]!;
              emitConnected(socket);
              return socket;
            },
          }),
        );
        const requests = yield* Effect.forEach(Array.from({ length: 2 }), () =>
          client.requestEffect({ action: "status" }).pipe(Effect.forkChild),
        );
        yield* Deferred.await(bothWritten);

        if (event === "error") {
          first.emit("error", new Error("socket boom"));
        } else {
          first.destroyed = true;
          first.emit("close");
        }
        const errors = yield* Effect.forEach(requests, (request) =>
          Fiber.join(request).pipe(Effect.flip),
        );

        expect(errors.every((error) => error instanceof ClientTransportError)).toBe(true);
        expect(
          errors.every(
            (error) => error.message === (event === "error" ? "socket boom" : "Socket closed"),
          ),
        ).toBe(true);
        expect(client.pendingRequestCount).toBe(0);
        expect(client.activeRequestTimerCount).toBe(0);
        expect(client.socketListenerCount).toBe(0);
        expect(first.listenerCount("data")).toBe(0);
        expect(first.listenerCount("error")).toBe(0);
        expect(first.listenerCount("close")).toBe(0);

        const recovered = yield* client.callEffect({ action: "status" });
        expect((recovered as StatusResult).pid).toBe(2);
        expect(connectCalls).toBe(2);
      });

    effectIt.effect("socket error rejects all pending requests and permits recovery", () =>
      terminalFailureProgram("error"),
    );

    effectIt.effect("socket close rejects all pending requests and permits recovery", () =>
      terminalFailureProgram("close"),
    );
  });

  describe("resolveDaemonNodeBinary", () => {
    it("prefers the configured reusable Node wrapper", () => {
      expect(resolveDaemonNodeBinary({ PI_ENV_NODE_BIN: "/opt/pi/node" })).toBe("/opt/pi/node");
    });

    it("uses the shared nonempty Node wrapper policy", () => {
      expect(resolveDaemonNodeBinary({})).toBe(process.execPath);
      expect(resolveDaemonNodeBinary({ PI_ENV_NODE_BIN: "   " })).toBe(process.execPath);
      expect(resolveDaemonNodeBinary({ PI_ENV_NODE_BIN: "  /opt/pi/node  " })).toBe("/opt/pi/node");
    });
  });

  it("keeps transport failures as typed operational errors", () => {
    const error = new ClientTransportError({ message: "boom" });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("boom");
  });
});
