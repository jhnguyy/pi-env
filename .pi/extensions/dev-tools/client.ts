/**
 * LSP Client — persistent Unix socket client with daemon spawn-on-demand.
 *
 * Responsibilities:
 * - Connect to the daemon socket (auto-spawn if not running)
 * - Send JSON-over-newline requests, receive responses
 * - Handle ECONNREFUSED / ENOENT (stale socket → remove + respawn)
 * - Timeout individual requests (5s default)
 */

import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseResponse,
  serializeRequest,
  SOCKET_PATH,
  type DaemonRequest,
  type DaemonResponse,
  type LspResult,
} from "./protocol";
import { sleep } from "./utils";
import { removeStaleArtifact } from "./socket-artifacts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SPAWN_RETRY_INTERVAL_MS = 200;
const SPAWN_RETRY_MAX_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Resolve the Node executable used for the detached daemon.
 *
 * Nix-managed pi can run Node through its dynamic loader. In that case
 * process.execPath is the loader itself, so spawning it with a JavaScript file
 * silently fails. Setup supplies PI_ENV_NODE_BIN as the reusable Node wrapper.
 */
export function resolveDaemonNodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env["PI_ENV_NODE_BIN"] || process.execPath;
}

// ─── LspClient ────────────────────────────────────────────────────────────────

export class LspClient {
  private socket: Socket | null = null;
  private pendingRequests = new Map<
    number,
    {
    resolve: (res: DaemonResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  private buf = "";
  private connectPromise: Promise<void> | null = null;
  private readonly closeController = new AbortController();
  private closed = false;

  constructor(
    private socketPath = SOCKET_PATH,
    private daemonScript = resolve(__dirname, "daemon.js"),
  ) {}

  /** Send a request to the daemon, auto-spawning if needed. */
  async request(req: Omit<DaemonRequest, "id">): Promise<DaemonResponse> {
    return this.doRequest(req, false);
  }

  /**
   * Internal: send with one automatic retry on timeout.
   *
   * First attempt: timeout rejects only this request (no socket teardown).
   * Other in-flight requests continue normally.
   *
   * Retry: tears down the socket, removes the socket file, spawns a fresh
   * daemon, then tries once more. If the daemon was truly unresponsive
   * (stale after rebuild/crash), the reconnect fixes it.
   */
  private async doRequest(
    req: Omit<DaemonRequest, "id">,
    isRetry: boolean,
  ): Promise<DaemonResponse> {
    await this.ensureConnected();
    this.assertOpen();

    const id = this.nextId++;
    const fullReq: DaemonRequest = { id, ...req };

    try {
      return await new Promise<DaemonResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          if (isRetry) {
            // On retry, tear down the socket — daemon is truly unresponsive.
            this.socket?.destroy();
            this.socket = null;
          }
          reject(new Error(`LSP request timed out: ${req.action}`));
        }, REQUEST_TIMEOUT_MS);

        this.pendingRequests.set(id, { resolve, reject, timer });
        this.socket!.write(serializeRequest(fullReq));
      });
    } catch (err) {
      if (!isRetry && err instanceof Error && err.message.startsWith("LSP request timed out")) {
        // Remove stale socket so doConnect() spawns a fresh daemon.
        removeStaleArtifact(this.socketPath);
        // Tear down for reconnect on retry path
        this.socket?.destroy();
        this.socket = null;
        return this.doRequest(req, true);
      }
      throw err;
    }
  }

  /** Convenience: send an action and unwrap the result or throw on error. */
  async call(req: Omit<DaemonRequest, "id">): Promise<LspResult> {
    const res = await this.request(req);
    if (!res.ok) throw new Error(res.error ?? "LSP error");
    return res.result!;
  }

  /** Close the socket connection. Does not shut down the daemon. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.settlePending(new Error("Client closed"));
  }

  // ─── Connection management ───────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    this.assertOpen();
    if (this.socket && !this.socket.destroyed) return;

    // Serialize connection attempts while allowing close() to reject every waiter.
    if (!this.connectPromise) {
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    }
    return this.raceWithClose(this.connectPromise);
  }

  private async doConnect(): Promise<void> {
    // Try to connect directly first
    const connected = await this.tryConnect();
    this.assertOpen();
    if (connected) return;

    // Remove stale socket file if present
    removeStaleArtifact(this.socketPath);

    // Spawn daemon
    await this.spawnDaemon();
    this.assertOpen();

    // Retry with backoff until connected or timeout
    const deadline = Date.now() + SPAWN_RETRY_MAX_MS;
    let delay = SPAWN_RETRY_INTERVAL_MS;

    while (Date.now() < deadline) {
      await sleep(delay);
      this.assertOpen();
      const ok = await this.tryConnect();
      this.assertOpen();
      if (ok) return;
      delay = Math.min(delay * 1.5, 1000);
    }

    throw new Error(`Failed to connect to LSP daemon after ${SPAWN_RETRY_MAX_MS}ms`);
  }

  private assertOpen(): void {
    if (!this.closed) return;
    this.socket?.destroy();
    this.socket = null;
    throw new Error("Client closed");
  }

  private raceWithClose<T>(promise: Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Client closed"));
    return new Promise<T>((resolve, reject) => {
      const onClose = () => settle(() => reject(new Error("Client closed")));
      const settle = (complete: () => void) => {
        this.closeController.signal.removeEventListener("abort", onClose);
        complete();
      };
      this.closeController.signal.addEventListener("abort", onClose, { once: true });
      promise.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  private tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!existsSync(this.socketPath)) {
        resolve(false);
        return;
      }

      const sock = connect(this.socketPath);
      const onConnect = () => {
        cleanup();
        this.setupSocket(sock);
        resolve(true);
      };
      const onError = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        sock.off("connect", onConnect);
        sock.off("error", onError);
      };
      sock.once("connect", onConnect);
      sock.once("error", onError);
    });
  }

  private setupSocket(sock: Socket): void {
    this.socket = sock;
    this.buf = "";
    sock.setEncoding("utf8");

    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const res = parseResponse(line);
          const pending = this.pendingRequests.get(res.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(res.id);
            pending.resolve(res);
          }
        } catch {
          // Skip malformed responses
        }
      }
    });

    sock.on("error", (err) => this.onSocketError(err));
    sock.on("close", () => this.settlePending(new Error("Socket closed")));
  }

  private settlePending(err: Error): void {
    this.socket = null;
    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pendingRequests.clear();
  }

  private onSocketError(err: Error): void {
    this.socket?.destroy();
    this.settlePending(err);
  }

  private spawnDaemon(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(resolveDaemonNodeBinary(), [this.daemonScript], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });
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
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }
}
