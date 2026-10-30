import { lstat, chmod, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createHost, webSocketLink } from "@earendil-works/chord";
import { WebSocketServer } from "ws";
import { SnapshotSchema, SubagentService, type Principal, type ServiceRuntime } from "./contract.ts";

/** The entry owns the process lock, private directory, and runtime throughout this lifetime. */
export async function serve(directory: string, runtime: ServiceRuntime): Promise<{ close(): Promise<void> }> {
  if (process.platform !== "linux") throw new Error("Subagent service requires Linux Unix sockets");
  const socketPath = join(directory, "service.sock");
  await removeStaleSocket(socketPath);
  const host = createHost<Principal>({ name: "pi-env-subagents", self: { kind: "owner" } });
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new Set<Socket>();
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  let accepting = false;
  let ownedSocket: Awaited<ReturnType<typeof lstat>> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    accepting = false;
    const failures: unknown[] = [];
    const attempt = async (action: () => void | Promise<void>) => {
      try { await action(); } catch (error) { failures.push(error); }
    };
    await attempt(() => host.close());
    await attempt(async () => {
      const stopped = new Promise<void>((resolve, reject) => ws.close((error) => error ? reject(error) : resolve()));
      for (const client of ws.clients) client.terminate();
      await stopped;
    });
    await attempt(async () => {
      const stopped = new Promise<void>((resolve, reject) => {
        http.close((error: NodeJS.ErrnoException | undefined) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
      });
      for (const socket of sockets) socket.destroy();
      await stopped;
    });
    await attempt(async () => {
      if (!ownedSocket) return;
      const entry = await socketEntry(socketPath);
      if (!entry) return; // Node normally removes its Unix socket on server close.
      if (entry.dev !== ownedSocket.dev || entry.ino !== ownedSocket.ino) {
        throw new Error("Service socket changed during shutdown; refusing to unlink it");
      }
      await unlink(socketPath);
    });
    if (failures.length) throw new AggregateError(failures, "Subagent transport cleanup failed");
  })();

  try {
    host.serve(SubagentService, (_input, _principal, self) => {
      const snapshot = self.state("snapshot", SnapshotSchema, { init: () => runtime.snapshot() });
      // Subscribe first, then reconcile: activation may have yielded since init captured its value.
      const source = {
        subscribe(listener: Parameters<ServiceRuntime["subscribe"]>[0]) {
          const stop = runtime.subscribe(listener);
          try { listener(runtime.snapshot()); } catch (error) {
            try { stop(); } catch (cleanup) {
              throw new AggregateError([error, cleanup], "Runtime subscription and cleanup failed", { cause: cleanup });
            }
            throw error;
          }
          return stop;
        },
      };
      self.on("runtime", source, (next, ctx) => {
        if (next.revision > snapshot.value.revision) snapshot.replace(ctx, next, { diff: true });
      });
      return {
        variant: "owner",
        snapshot,
        // The runtime owns accepted operations, not the calling link or its cancellation context.
        submit: (input) => runtime.submit(input),
        input: (input) => runtime.input(input),
        cancel: (input) => runtime.cancel(input),
        inspect: ({ childId }) => runtime.inspect(childId),
      };
    });
    http.on("upgrade", (request, socket, head) => {
      if (!accepting) { socket.destroy(); return; }
      ws.handleUpgrade(request, socket, head, (client) => {
        // Protocol/payload failures also emit error; Chord observes the resulting close.
        client.on("error", () => {});
        host.accept(webSocketLink(client, { acceptPacked: false }), { principal: { kind: "owner" }, kind: "client", maxCalls: 128 });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { http.off("listening", ready); reject(error); };
      const ready = () => { http.off("error", failed); resolve(); };
      http.once("error", failed);
      http.once("listening", ready);
      http.listen(socketPath);
    });
    ownedSocket = await socketEntry(socketPath);
    if (!ownedSocket) throw new Error("Service socket disappeared during startup");
    await chmod(socketPath, 0o600);
    accepting = true;
    return { close };
  } catch (error) {
    try { await close(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Subagent transport startup and cleanup failed", { cause: cleanup });
    }
    throw error;
  }
}

async function socketEntry(path: string) {
  const entry = await lstat(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (entry && (!entry.isSocket() || entry.uid !== process.getuid?.())) {
    throw new Error("Refusing non-socket or foreign-owned service socket entry");
  }
  return entry;
}

async function removeStaleSocket(path: string): Promise<void> {
  const before = await socketEntry(path);
  if (!before) return;
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(10_000, () => { probe.destroy(); reject(new Error("Service socket stale check timed out")); });
    probe.once("connect", () => { probe.destroy(); reject(new Error("Subagent service socket is already active")); });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  const after = await socketEntry(path);
  if (!after) return;
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Service socket changed during stale check");
  await unlink(path);
}
