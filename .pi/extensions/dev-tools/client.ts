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
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseResponse, serializeRequest, SOCKET_PATH, PID_PATH, type DaemonRequest, type DaemonResponse, type LspResult } from "./protocol";
import { sleep } from "./utils";

// ─── Constants ────────────────────────────────────────────────────────────────

const SPAWN_RETRY_INTERVAL_MS = 200;
const SPAWN_RETRY_MAX_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ─── LspClient ────────────────────────────────────────────────────────────────

export class LspClient {
  private socket: Socket | null = null;
  private pendingRequests = new Map<number, {
    resolve: (res: DaemonResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private buf = "";
  private connecting = false;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private socketPath = SOCKET_PATH,
    private pidPath = PID_PATH,
    private daemonScript = resolve(__dirname, "daemon.ts"),
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
      if (
        !isRetry &&
        err instanceof Error &&
        err.message.startsWith("LSP request timed out")
      ) {
        // Remove stale socket so doConnect() spawns a fresh daemon.
        try { unlinkSync(this.socketPath); } catch {}
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
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(new Error("Client closed"));
    }
    this.pendingRequests.clear();
  }

  // ─── Connection management ───────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

    // Serialize connection attempts
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    // Try to connect directly first
    const connected = await this.tryConnect();
    if (connected) return;

    // Remove stale socket file if present
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }

    // Spawn daemon
    await this.spawnDaemon();

    // Retry with backoff until connected or timeout
    const deadline = Date.now() + SPAWN_RETRY_MAX_MS;
    let delay = SPAWN_RETRY_INTERVAL_MS;

    while (Date.now() < deadline) {
      await sleep(delay);
      const ok = await this.tryConnect();
      if (ok) return;
      delay = Math.min(delay * 1.5, 1000);
    }

    throw new Error(`Failed to connect to LSP daemon after ${SPAWN_RETRY_MAX_MS}ms`);
  }

  private tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!existsSync(this.socketPath)) { resolve(false); return; }

      const sock = connect(this.socketPath);
      const onConnect = () => {
        cleanup();
        this.setupSocket(sock);
        resolve(true);
      };
      const onError = () => { cleanup(); resolve(false); };
      const cleanup = () => { sock.off("connect", onConnect); sock.off("error", onError); };
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
    sock.on("close", () => {
      this.socket = null;
      // Reject all pending requests
      for (const { reject, timer } of this.pendingRequests.values()) {
        clearTimeout(timer);
        reject(new Error("Socket closed"));
      }
      this.pendingRequests.clear();
    });
  }

  private onSocketError(_err: Error): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private spawnDaemon(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("bun", ["run", this.daemonScript], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });

      child.on("error", reject);
      child.unref();

      // Give it a moment to start up before resolving
      setTimeout(resolve, 100);
    });
  }
}

