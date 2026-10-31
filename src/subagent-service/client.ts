import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { createHost, webSocketLink, type Ref } from "@earendil-works/chord";
import WebSocket from "ws";
import { SubagentInspection, SubagentService, type Principal } from "./contract.ts";

export type ServiceView = Ref<typeof SubagentService>;

/** Explicit connection only: a lost link requires a fresh connect, not a spawned service. */
export type InspectionView = Ref<typeof SubagentInspection>;
async function privateSocketPath(directory: string): Promise<string> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.() || (entry.mode & 0o7777) !== 0o700) {
    throw new Error("Subagent service directory must be an owned, non-symlink directory with mode 0700");
  }
  const socketPath = join(directory, "service.sock");
  const socketEntry = await lstat(socketPath);
  if (!socketEntry.isSocket() || socketEntry.uid !== process.getuid?.() || (socketEntry.mode & 0o7777) !== 0o600) {
    throw new Error("Subagent service socket must be an owned socket with mode 0600");
  }
  return socketPath;
}

export async function connect(directory: string, parentSessionId: string, expectedBundleId?: string): Promise<{ view: ServiceView; signal: AbortSignal; inspect(childId: string): Promise<InspectionView>; close(): Promise<void> }> {
  if (!parentSessionId || parentSessionId.length > 256) throw new Error("invalid_parent_session_id");
  if (process.platform !== "linux") throw new Error("Subagent service requires Linux Unix sockets");
  const socketPath = await privateSocketPath(directory);
  // Override the dialer rather than encoding paths in ws's colon-delimited ws+unix URL syntax.
  const socket = new WebSocket("ws://localhost/", {
    createConnection: () => createConnection({ path: socketPath }),
    maxPayload: 256 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 10_000,
  });
  const host = createHost<Principal>({ name: "pi-env-subagent-client", self: { kind: "owner" }, kind: "client", readyTimeout: 10_000 });
  let view: ServiceView | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    const failures: unknown[] = [];
    try { view?.release(); } catch (error) { failures.push(error); }
    try { await host.close(); } catch (error) { failures.push(error); }
    try {
      if (socket.readyState !== WebSocket.CLOSED) {
        const stopped = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        socket.terminate();
        await stopped;
      }
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Subagent client cleanup failed");
  })();
  // ws emits errors as well as close; keep them handled after the opening promise settles.
  socket.on("error", () => {});
  try {
    const link = webSocketLink(socket, { acceptPacked: false });
    const disconnected = new AbortController();
    link.onClose((reason) => disconnected.abort(new Error(reason)));
    host.connect(link, { principal: { kind: "owner" } });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off("open", opened); socket.off("error", failed); socket.off("close", ended); };
      const opened = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const ended = () => { cleanup(); reject(new Error("Subagent connection closed before opening")); };
      socket.once("open", opened);
      socket.once("error", failed);
      socket.once("close", ended);
    });
    view = await host.get(SubagentService, { parentSessionId }, { signal: disconnected.signal });
    // Chord retains bindings for reconnection by default; this client deliberately ends its host instead.
    link.onClose(() => { void close().catch((error: unknown) => console.error("Subagent client close failed", error)); });
    if (link.closed) throw new Error("Subagent connection closed during acquisition");
    if (expectedBundleId !== undefined && view.snapshot.value.bundleId !== expectedBundleId) throw new Error("incompatible_service_bundle: drain the existing service before changing its executable");
    return { view, signal: disconnected.signal, inspect: (childId) => host.get(SubagentInspection, { parentSessionId, childId }, { signal: disconnected.signal }), close };
  } catch (error) {
    try { await close(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Subagent connection and cleanup failed", { cause: cleanup });
    }
    throw error;
  }
}
