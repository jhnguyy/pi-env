#!/usr/bin/env node
/**
 * LSP Daemon — standalone process that manages language servers.
 *
 * Manages multiple language server backends (TypeScript, Bash, Nix) via a
 * shared Unix socket. Backends start lazily on first file request and are
 * routed by file extension.
 *
 * Business logic lives in:
 *   - backend.ts   — LspBackend: per-language-server subprocess manager
 *   - handlers.ts  — LSP action handlers (diagnostics, hover, definition, etc.)
 *   - action-registry.ts — handler/formatter/renderer dispatch (no switch chains)
 *
 * Lifecycle:
 *   - Spawned by client.ts if socket not available
 *   - Writes PID to /tmp/pi-lsp-$UID.pid
 *   - Listens on /tmp/pi-lsp-$UID.sock
 *   - Auto-shuts down after inactivity (default: 10 min, PI_LSP_IDLE_TIMEOUT_MS overrides)
 *
 * Run directly after build: node dist/daemon.js
 */

import { createServer, type Socket, type Server } from "node:net";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LspBackend } from "./backend";
import { BACKEND_CONFIGS, BackendMode, type LspBackendConfig } from "./backend-configs";
import { FileCache } from "./file-cache";
import { type HandlerDeps } from "./handlers";
import { getAction } from "./action-registry";
import "./register-actions"; // side-effect: populates the action registry
import { parseRequest, serializeResponse, errorResponse, okResponse, SOCKET_PATH, PID_PATH } from "./protocol";
import type { DaemonRequest, DaemonResponse, StatusResult } from "./protocol";
import { removeStaleArtifact, removeStaleArtifacts } from "./socket-artifacts";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function lspIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env["PI_LSP_IDLE_TIMEOUT_MS"]);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDLE_TIMEOUT_MS;
}
/** Max bytes to buffer per connection before disconnecting. Prevents OOM from malformed clients. */
const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB

// ─── Per-backend LSP capabilities ─────────────────────────────────────────────

// ─── LspDaemon ───────────────────────────────────────────────────────────────

export class LspDaemon {
  private backends: LspBackend[];
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private fileCache = new FileCache();

  /** Timestamp of the activity *before* the current request. Used for accurate idle reporting. */
  private previousActivity = Date.now();
  private lastActivity = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private socketPath = SOCKET_PATH,
    private pidPath = PID_PATH,
    private idleTimeoutMs = lspIdleTimeoutMs(),
  ) {
    this.backends = (BACKEND_CONFIGS.filter((c) => c.mode === BackendMode.Lsp) as LspBackendConfig[])
      .map((config) => new LspBackend(config));
  }

  /** Return the backend that handles this file. Throws if no backend matches. */
  private getBackend(filePath: string): LspBackend {
    const backend = this.backends.find((b) => b.handles(filePath));
    if (!backend) throw new Error(`No language server configured for: ${filePath}`);
    return backend;
  }

  /** Return backends that support workspace/symbol queries. */
  private getWorkspaceSymbolBackends(): LspBackend[] {
    return this.backends.filter((b) => b.supportsWorkspaceSymbols);
  }

  // ─── Startup ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    writeFileSync(this.pidPath, String(process.pid), "utf8");

    removeStaleArtifact(this.socketPath);

    await this.startServer();
    this.resetIdleTimer();
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  // ─── Connection handling ─────────────────────────────────────────────────────

  private handleConnection(socket: Socket): void {
    let buf = "";
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setEncoding("utf8");

    socket.on("data", (chunk: string) => {
      buf += chunk;
      // Guard against unbounded buffer from malformed clients
      if (buf.length > MAX_BUFFER_BYTES) {
        socket.destroy();
        return;
      }
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) void this.handleRequest(socket, line);
      }
    });

    socket.on("error", () => socket.destroy());
  }

  private async handleRequest(socket: Socket, line: string): Promise<void> {
    this.previousActivity = this.lastActivity;
    this.lastActivity = Date.now();
    this.resetIdleTimer();

    let req: DaemonRequest;
    try {
      req = parseRequest(line);
    } catch {
      socket.write(serializeResponse(errorResponse(0, "Invalid request JSON")));
      return;
    }

    let response: DaemonResponse;
    try {
      response = await this.dispatch(req);
    } catch (err: unknown) {
      response = errorResponse(req.id, err instanceof Error ? err.message : "Unknown error");
    }

    const serialized = serializeResponse(response);
    if (req.action === "shutdown") {
      socket.end(serialized, () => { void this.shutdown(); });
    } else {
      socket.write(serialized);
    }
  }

  private async dispatch(req: DaemonRequest): Promise<DaemonResponse> {
    const deps: HandlerDeps = {
      getBackend: (p) => this.getBackend(p),
      getWorkspaceSymbolBackends: () => this.getWorkspaceSymbolBackends(),
      backends: this.backends,
      fileCache: this.fileCache,
      getIdleMs: () => Date.now() - this.previousActivity,
    };

    // Shutdown is handled inline — not a registered action
    if (req.action === "shutdown") {
      return okResponse(req.id, {
        action: "status", running: false, projects: [], openFiles: [], watchedFiles: 0, idleMs: 0,
      } as StatusResult);
    }

    // Try the registry first
    const action = getAction(req.action);
    if (action) return action.handler(req, deps);

    return errorResponse(req.id, `Unknown action: ${req.action}`);
  }

  // ─── Idle / Shutdown ─────────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.shutdown(), this.idleTimeoutMs);
  }

  private shutdownPromise: Promise<void> | null = null;

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      await Promise.all(this.backends.map((backend) => backend.shutdown()));
      const server = this.server;
      this.server = null;
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      removeStaleArtifacts([this.socketPath, this.pidPath]);
    })();
    return this.shutdownPromise;
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const daemon = new LspDaemon();
  process.on("SIGTERM", () => void daemon.shutdown().then(() => process.exit(0)));
  process.on("SIGINT", () => void daemon.shutdown().then(() => process.exit(0)));
  daemon.start().catch((err) => {
    console.error("Daemon failed to start:", err);
    process.exit(1);
  });
}
