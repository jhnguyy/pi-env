import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, Server, Socket } from "node:net";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import * as TempDir from "../../../src/testing/temp-dir";
import { noopToolingTelemetryRuntime } from "../../../src/telemetry/tooling";
import { LspDaemon } from "../daemon";
import { parseResponse, serializeRequest, type DaemonResponse } from "../protocol";
import { ControlledBackend } from "./controlled-backend";
import { pathToUri } from "../utils";

function responses(socket: Socket, count = 1): Promise<DaemonResponse[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const received: DaemonResponse[] = [];
    function finish(error?: Error) {
      socket.off("data", data);
      socket.off("error", finish);
      socket.off("close", closed);
      if (error) reject(error);
      else resolve(received);
    }
    const closed = () =>
      finish(new Error(`Connection closed after ${received.length}/${count} responses`));
    function data(chunk: string) {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        received.push(parseResponse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
      if (received.length >= count) finish();
    }
    socket.on("data", data);
    socket.once("error", finish);
    socket.once("close", closed);
  });
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("daemon socket lifecycle", () => {
  let root: string;
  let socketPath: string;
  let pidPath: string;
  let daemon: LspDaemon;
  let backend: ControlledBackend;
  let secondBackend: ControlledBackend;
  let disposeCalls: number;
  let releaseCleanup: (() => void) | undefined;
  let expectedShutdownError: unknown;
  let disposalFailure: Error | undefined;
  let onDispose: (() => Promise<void>) | undefined;
  const sockets: Socket[] = [];

  beforeEach(() => {
    root = TempDir.forTestSync("daemon-socket-");
    socketPath = join(root, "daemon.sock");
    pidPath = join(root, "daemon.pid");
    backend = new ControlledBackend(root);
    secondBackend = new ControlledBackend(root, "bash", ".sh");
    disposeCalls = 0;
    releaseCleanup = undefined;
    expectedShutdownError = undefined;
    disposalFailure = undefined;
    onDispose = undefined;
    daemon = new LspDaemon(
      socketPath,
      pidPath,
      60_000,
      {
        ...noopToolingTelemetryRuntime,
        disposeEffect: Effect.promise(async () => {
          disposeCalls++;
          await onDispose?.();
          if (disposalFailure) throw disposalFailure;
        }),
      },
      { backends: [backend, secondBackend] },
    );
  });

  afterEach(async () => {
    releaseCleanup?.();
    for (const socket of sockets.splice(0)) socket.destroy();
    const failures: unknown[] = [];
    try {
      await daemon.shutdown();
    } catch (error) {
      if (error !== expectedShutdownError) failures.push(error);
    }
    vi.restoreAllMocks();
    if (failures.length) throw new AggregateError(failures, "Socket fixture teardown failed");
  });

  async function open(): Promise<Socket> {
    const socket = connect(socketPath);
    sockets.push(socket);
    socket.setEncoding("utf8");
    await once(socket, "connect");
    return socket;
  }

  it("acknowledges stop and ends the protocol before blocked cleanup completes", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const work = gate();
    const cleanup = gate();
    const cleaning = gate();
    releaseCleanup = () => {
      work.release();
      cleanup.release();
    };
    backend.onShutdown = async () => {
      cleaning.release();
      await cleanup.promise;
    };
    backend.lspRequest = async () => {
      await work.promise;
      return { jsonrpc: "2.0", id: 1, result: { contents: "ready" } };
    };
    await daemon.start();
    const peer = await open();
    const peerClosed = once(peer, "close");
    const socket = await open();
    const closed = once(socket, "close");
    const ended = once(socket, "end");
    const write = Socket.prototype.write;
    let ackWrites = 0;
    vi.spyOn(Socket.prototype, "write").mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket["write"]>
    ) {
      if (
        typeof args[0] === "string" &&
        args[0].includes('"running":false') &&
        args[0].includes('"id":2')
      ) {
        ackWrites++;
        // Deliver the ack, but withhold its callback and report backpressure.
        write.call(this, args[0]);
        return false;
      }
      return write.call(this, ...args);
    });
    const received = responses(socket, 3);
    const accepted = responses(socket, 2);
    const hover = {
      action: "hover" as const,
      path: join(root, "file.ts"),
      line: 1,
      character: 1,
    };
    socket.write(
      serializeRequest({ id: 1, ...hover }) +
        serializeRequest({ id: 2, action: "shutdown" }) +
        serializeRequest({ id: 3, ...hover }),
    );
    expect(await accepted).toContainEqual(
      expect.objectContaining({
        id: 2,
        ok: true,
        result: expect.objectContaining({ running: false }),
      }),
    );
    const peerReply = responses(peer);
    peer.write(serializeRequest({ id: 4, ...hover }));
    expect(await peerReply).toMatchObject([{ id: 4, ok: false }]);
    let stopped = false;
    const stops = Promise.allSettled([daemon.shutdown(), daemon.shutdown()]).then((outcomes) => {
      stopped = true;
      return outcomes;
    });
    const newcomer = await open();
    await once(newcomer, "close");
    expect(backend.opened).toEqual([hover.path]);
    expect(backend.shutdownCalls).toBe(0);
    expect(disposeCalls).toBe(0);
    expect(socket.destroyed).toBe(false);
    expect(existsSync(pidPath)).toBe(true);
    work.release();
    const replies = await received;
    expect(replies).toContainEqual(expect.objectContaining({ id: 1, ok: true }));
    expect(replies).toContainEqual(expect.objectContaining({ id: 3, ok: false }));
    await Promise.all([ended, cleaning.promise]);
    // EOF ends the protocol exchange, not backend cleanup.
    expect(stopped).toBe(false);
    expect(backend.opened).toEqual([hover.path]);
    expect(disposeCalls).toBe(0);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    cleanup.release();
    expect(await stops).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    await Promise.all([closed, peerClosed]);
    expect(logged).not.toHaveBeenCalled();
    await daemon.shutdown();
    expect(backend.opened).toEqual([hover.path]);
    await expect(daemon.start()).rejects.toThrow(/stopp/);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
    expect(backend.shutdownCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    expect(ackWrites).toBe(1);
  });

  it("idle shutdown closes admission without rearming while earlier work drains", async () => {
    const timer = setTimeout(() => {}, 60_000);
    let expire!: () => void;
    const schedule = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: () => void) => {
        expire = callback;
        return timer;
      });
    const work = gate();
    const entered = gate();
    releaseCleanup = work.release;
    backend.lspRequest = async () => {
      entered.release();
      await work.promise;
      return { jsonrpc: "2.0", id: 1, result: { contents: "ready" } };
    };
    await daemon.start();
    const socket = await open();
    const hover = { action: "hover" as const, path: join(root, "file.ts"), line: 1, character: 1 };
    socket.write(serializeRequest({ id: 1, ...hover }));
    await entered.promise;
    expire();
    const scheduledAtStop = schedule.mock.calls.length;
    const late = responses(socket);
    socket.write(serializeRequest({ id: 2, ...hover }));
    expect(await late).toMatchObject([{ id: 2, ok: false }]);
    expect(schedule).toHaveBeenCalledTimes(scheduledAtStop);
    expect(backend.opened).toEqual([hover.path]);
    expect(backend.shutdownCalls).toBe(0);
    work.release();
    await daemon.shutdown();
    expect(schedule).toHaveBeenCalledTimes(scheduledAtStop);
    expect(backend.opened).toEqual([hover.path]);
    expect(disposeCalls).toBe(1);
  });

  it("drains a disconnected committed rename before reporting every independent shutdown failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const syncFailure = new Error("synchronous backend failure");
    const asyncFailure = new Error("asynchronous backend failure");
    const telemetryFailure = new Error("telemetry failure");
    let asyncSettled = false;
    let stateAtDisposal: { asyncSettled: boolean; socket: boolean; pid: boolean } | undefined;
    const cleanup = gate();
    const cleaning = gate();
    backend.shutdown = () => {
      backend.shutdownCalls++;
      throw syncFailure;
    };
    secondBackend.onShutdown = async () => {
      cleaning.release();
      await cleanup.promise;
      asyncSettled = true;
      throw asyncFailure;
    };
    onDispose = async () => {
      stateAtDisposal = {
        asyncSettled,
        socket: existsSync(socketPath),
        pid: existsSync(pidPath),
      };
      throw telemetryFailure;
    };
    const source = join(root, "source.ts");
    const target = join(root, "target.ts");
    writeFileSync(source, "old");
    writeFileSync(target, "old");
    backend.responses.set("textDocument/rename", {
      changes: {
        [pathToUri(source)]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "new",
          },
        ],
        [pathToUri(target)]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "new",
          },
        ],
      },
    });
    const refresh = gate();
    const entered = gate();
    releaseCleanup = () => {
      refresh.release();
      cleanup.release();
    };
    let opened = false;
    let refreshed = false;
    const refreshes: string[] = [];
    backend.ensureFile = async (path) => {
      if (!opened) {
        opened = true;
        return pathToUri(path);
      }
      refreshes.push(path);
      if (path === source) throw new Error("refresh failed after commit");
      entered.release();
      await refresh.promise;
      refreshed = true;
      return pathToUri(path);
    };
    await daemon.start();
    const socket = await open();
    socket.write(
      serializeRequest({
        id: 1,
        action: "rename",
        path: source,
        line: 1,
        character: 1,
        newName: "new",
      }),
    );
    await entered.promise;
    const closed = once(socket, "close");
    socket.destroy();
    await closed;
    const stopSocket = await open();
    const stopClosed = once(stopSocket, "close");
    const reply = responses(stopSocket);
    stopSocket.write(serializeRequest({ id: 2, action: "shutdown" }));
    expect(await reply).toMatchObject([{ id: 2, ok: true, result: { running: false } }]);
    const outcome = daemon.shutdown().catch((error: unknown) => {
      expectedShutdownError = error;
      return error;
    });
    const concurrentOutcome = daemon.shutdown().catch((error: unknown) => error);
    expect(backend.shutdownCalls).toBe(0);
    expect(secondBackend.shutdownCalls).toBe(0);
    expect(disposeCalls).toBe(0);
    expect(readFileSync(source, "utf8")).toBe("new");
    expect(readFileSync(target, "utf8")).toBe("new");
    // Only already-owned artifacts fail release; acquisition and rename succeeded.
    for (const path of [pidPath, socketPath]) {
      rmSync(path);
      mkdirSync(path);
    }
    refresh.release();
    await Promise.race([cleaning.promise, outcome]);
    expect(secondBackend.shutdownCalls).toBe(1);
    expect(refreshed).toBe(true);
    expect(refreshes).toEqual([source, target]);
    expect(disposeCalls).toBe(0);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    expect(stopSocket.destroyed).toBe(false);
    cleanup.release();
    const error = await outcome;
    expect(await concurrentOutcome).toBe(error);
    expect(error).toBeInstanceOf(AggregateError);
    const failures = (error as AggregateError).errors;
    expect(failures).toHaveLength(5);
    expect(failures).toEqual(
      expect.arrayContaining([
        syncFailure,
        asyncFailure,
        telemetryFailure,
        expect.objectContaining({ code: "EISDIR", path: socketPath }),
        expect.objectContaining({ code: "EISDIR", path: pidPath }),
      ]),
    );
    await stopClosed;
    expect(logged).toHaveBeenCalledWith("[dev-tools-daemon] shutdown failed:", error);
    expect(backend.shutdownCalls).toBe(1);
    expect(secondBackend.shutdownCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    expect(stateAtDisposal).toEqual({
      asyncSettled: true,
      socket: true,
      pid: true,
    });
    await expect(daemon.shutdown()).rejects.toBe(error);
  });

  it("attempts independent releases while listener close waits for a failed socket release", async () => {
    await daemon.start();
    const first = await open();
    const second = await open();
    const closed = [once(first, "close"), once(second, "close")];
    const destroyFailure = new Error("socket destruction failed");
    const closeFailure = new Error("listener close failed");
    const destroy = Socket.prototype.destroy;
    let ownedDestroyed = 0;
    vi.spyOn(Socket.prototype, "destroy").mockImplementation(function (
      this: Socket,
      error?: Error,
    ) {
      if (!sockets.includes(this)) {
        ownedDestroyed++;
        if (ownedDestroyed === 1) throw destroyFailure;
      }
      return destroy.call(this, error);
    });
    const close = Server.prototype.close;
    vi.spyOn(Server.prototype, "close").mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void,
    ) {
      return close.call(this, () => callback?.(closeFailure));
    });
    const disposed = gate();
    const dispose = gate();
    releaseCleanup = dispose.release;
    onDispose = async () => {
      disposed.release();
      await dispose.promise;
    };
    let settled = false;
    const outcome = daemon
      .shutdown()
      .catch((failure: unknown) => {
        expectedShutdownError = failure;
        return failure;
      })
      .finally(() => {
        settled = true;
      });
    try {
      await disposed.promise;
      expect(ownedDestroyed).toBe(2);
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidPath)).toBe(false);
      expect(settled).toBe(false);
      dispose.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposeCalls).toBe(1);
      expect(settled).toBe(false);
    } finally {
      dispose.release();
      first.destroy();
      second.destroy();
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([destroyFailure, closeFailure]),
    );
    await Promise.all(closed);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
    expect(disposeCalls).toBe(1);
    await expect(daemon.shutdown()).rejects.toBe(error);
  });

  it("cleans partial startup without deleting unowned artifacts or masking startup failure", async () => {
    mkdirSync(pidPath);
    writeFileSync(socketPath, "not acquired");
    disposalFailure = new Error("startup disposal failed");
    const startup = daemon.start();
    const concurrentOutcome = daemon.start().catch((error: unknown) => error);
    const outcome = await startup.catch((error: unknown) => error);
    expect(await concurrentOutcome).toBe(outcome);
    expect(outcome).toBeInstanceOf(AggregateError);
    const [startupFailure, cleanupFailure] = (outcome as AggregateError).errors;
    expect(startupFailure).toMatchObject({ code: "EISDIR" });
    expect((outcome as AggregateError).cause).toBe(startupFailure);
    expect(cleanupFailure).toBe(disposalFailure);
    expectedShutdownError = disposalFailure;
    await expect(daemon.shutdown()).rejects.toBe(disposalFailure);
    await expect(daemon.shutdown()).rejects.toBe(disposalFailure);
    expect(readFileSync(socketPath, "utf8")).toBe("not acquired");
    expect(existsSync(pidPath)).toBe(true);
    expect(disposeCalls).toBe(1);
    expect(backend.shutdownCalls).toBe(1);
  });

  it("coalesces startup and cannot resurrect after shutdown during startup", async () => {
    const startup = daemon.start();
    const concurrentOutcome = daemon.start().catch((error: unknown) => error);
    await Promise.resolve();
    const outcome = startup.catch((error: unknown) => error);
    const stopping = daemon.shutdown();
    expect(await outcome).toMatchObject({ message: "Daemon startup stopped" });
    expect(await concurrentOutcome).toMatchObject({ message: "Daemon startup stopped" });
    await stopping;
    await expect(daemon.start()).rejects.toThrow(/stopp/);
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(backend.shutdownCalls).toBe(1);
    expect(disposeCalls).toBe(1);
  });

  it("recovers invalid JSON and envelopes alongside fragmented, coalesced and blank frames", async () => {
    await daemon.start();
    const socket = await open();
    const invalidEnvelopes = [
      "null",
      "[]",
      "true",
      "42",
      '"status"',
      "{}",
      '{"id":1}',
      '{"id":1,"action":null}',
      '{"id":1,"action":[]}',
      '{"id":1,"action":""}',
      '{"id":1,"action":"   "}',
      '{"action":"status"}',
      '{"id":null,"action":"status"}',
      '{"id":"1","action":"status"}',
      '{"id":1e400,"action":"status"}',
    ];
    const frame = serializeRequest({ id: 4, action: "status" });
    const received = responses(socket, invalidEnvelopes.length + 8);
    await new Promise<void>((resolve, reject) =>
      socket.write(frame.slice(0, 8), (error) => (error ? reject(error) : resolve())),
    );
    socket.write(
      frame.slice(8) +
        " \n\n{not valid json}\n" +
        invalidEnvelopes.join("\n") +
        "\n" +
        '{"id":8,"action":"unknown-action"}\n' +
        serializeRequest({ id: 0, action: "status" }) +
        serializeRequest({ id: -1.5, action: "status" }) +
        serializeRequest({ id: 1e20, action: "status" }) +
        serializeRequest({ id: 5, action: "status" }) +
        serializeRequest({ id: 6, action: "status" }),
    );
    const replies = await received;
    expect(replies).toContainEqual({ id: 0, ok: false, error: "Invalid request JSON" });
    expect(replies.filter((reply) => reply.error === "Invalid request envelope")).toHaveLength(
      invalidEnvelopes.length,
    );
    expect(replies).toContainEqual({ id: 8, ok: false, error: "Unknown action: unknown-action" });
    expect(
      replies
        .filter((reply) => reply.ok)
        .map((reply) => reply.id)
        .sort((a, b) => a - b),
    ).toEqual([-1.5, 0, 4, 5, 6, 1e20]);
    const healthy = responses(socket);
    socket.write(serializeRequest({ id: 9, action: "status" }));
    expect(await healthy).toMatchObject([{ id: 9, ok: true }]);
  });

  it("closes oversized incomplete input without stopping the listener", async () => {
    await daemon.start();
    const socket = await open();
    const closed = once(socket, "close");
    socket.write(" ".repeat(1024 * 1024 + 1));
    await closed;
    expect(socket.destroyed).toBe(true);
    const healthy = await open();
    const received = responses(healthy);
    healthy.write(serializeRequest({ id: 7, action: "status" }));
    expect(await received).toMatchObject([{ id: 7, ok: true }]);
  });
});
