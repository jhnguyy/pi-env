import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { noopToolingTelemetryRuntime } from "../../../../src/telemetry/tooling";
import { LspDaemon } from "../daemon";
import { parseResponse, serializeRequest, type DaemonResponse } from "../protocol";
import { ControlledBackend } from "./controlled-backend";

function responses(socket: Socket, count = 1): Promise<DaemonResponse[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const received: DaemonResponse[] = [];
    function data(chunk: string) {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        received.push(parseResponse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
      if (received.length === count) {
        socket.off("data", data);
        socket.off("error", reject);
        resolve(received);
      }
    }
    socket.on("data", data);
    socket.once("error", reject);
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
  let disposeCalls: number;
  let releaseCleanup: (() => void) | undefined;
  const sockets: Socket[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "daemon-socket-"));
    socketPath = join(root, "daemon.sock");
    pidPath = join(root, "daemon.pid");
    backend = new ControlledBackend(root);
    disposeCalls = 0;
    releaseCleanup = undefined;
    daemon = new LspDaemon(
      socketPath,
      pidPath,
      60_000,
      {
        ...noopToolingTelemetryRuntime,
        disposeEffect: Effect.sync(() => {
          disposeCalls++;
        }),
      },
      { backends: [backend] },
    );
  });

  afterEach(async () => {
    releaseCleanup?.();
    for (const socket of sockets.splice(0)) socket.destroy();
    const failures: unknown[] = [];
    try {
      await daemon.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Socket fixture teardown failed");
  });

  async function open(): Promise<Socket> {
    const socket = connect(socketPath);
    sockets.push(socket);
    socket.setEncoding("utf8");
    await once(socket, "connect");
    return socket;
  }

  it("closes active clients and removes artifacts after public shutdown, disposing once", async () => {
    await daemon.start();
    expect(existsSync(pidPath)).toBe(true);
    const socket = await open();
    const closed = once(socket, "close");
    await Promise.all([daemon.shutdown(), daemon.shutdown()]);
    await closed;
    await daemon.shutdown();
    expect(socket.destroyed).toBe(true);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
    expect(backend.shutdownCalls).toBe(1);
    expect(disposeCalls).toBe(1);
  });

  it("acknowledges shutdown before blocked backend cleanup, then completes cleanup in order", async () => {
    const cleanup = gate();
    const entered = gate();
    releaseCleanup = cleanup.release;
    backend.onShutdown = async () => {
      entered.release();
      await cleanup.promise;
    };
    await daemon.start();
    const observer = await open();
    const observerClosed = once(observer, "close");
    const socket = await open();
    const received = responses(socket);
    socket.write(serializeRequest({ id: 2, action: "shutdown" }));
    const [ack] = await received;
    expect(ack).toMatchObject({ id: 2, ok: true, result: { action: "status", running: false } });
    await entered.promise;
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    expect(observer.destroyed).toBe(false);
    expect(disposeCalls).toBe(0);
    cleanup.release();
    await daemon.shutdown();
    await observerClosed;
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
    expect(disposeCalls).toBe(1);
  });

  it("returns the invalid JSON response and continues accepting requests", async () => {
    await daemon.start();
    const socket = await open();
    const received = responses(socket, 2);
    socket.write("{not valid json}\n" + serializeRequest({ id: 3, action: "status" }));
    const replies = await received;
    expect(replies).toContainEqual({ id: 0, ok: false, error: "Invalid request JSON" });
    expect(replies).toContainEqual(expect.objectContaining({ id: 3, ok: true }));
  });

  it("buffers fragmented frames and dispatches coalesced frames, ignoring blank lines", async () => {
    await daemon.start();
    const socket = await open();
    const frame = serializeRequest({ id: 4, action: "status" });
    const received = responses(socket, 3);
    await new Promise<void>((resolve, reject) =>
      socket.write(frame.slice(0, 8), (error) => (error ? reject(error) : resolve())),
    );
    socket.write(
      frame.slice(8) +
        " \n\n" +
        serializeRequest({ id: 5, action: "status" }) +
        serializeRequest({ id: 6, action: "status" }),
    );
    expect((await received).map((response) => response.id).sort()).toEqual([4, 5, 6]);
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
