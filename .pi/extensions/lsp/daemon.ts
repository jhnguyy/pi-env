#!/usr/bin/env bun
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
 *
 * Lifecycle:
 *   - Spawned by client.ts if socket not available
 *   - Writes PID to /tmp/pi-lsp-$UID.pid
 *   - Listens on /tmp/pi-lsp-$UID.sock
 *   - Auto-shuts down after IDLE_TIMEOUT_MS of inactivity (default: 30 min)
 *
 * Run directly: bun run daemon.ts
 */

import { createServer, type Socket, type Server } from "node:net";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

import { LspBackend, STANDARD_CAPABILITIES } from "./backend";
import {
  handleDiagnostics, handleHover, handleDefinition,
  handleReferences, handleSymbols, handleStatus,
  type HandlerDeps,
} from "./handlers";
import { TS_EXTENSIONS, BASH_EXTENSIONS, NIX_EXTENSIONS } from "./filetypes";
import { parseRequest, serializeResponse, errorResponse, okResponse, SOCKET_PATH, PID_PATH } from "./protocol";
import type { DaemonRequest, DaemonResponse, StatusResult } from "./protocol";

// ─── Constants ────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ─── LspDaemon ───────────────────────────────────────────────────────────────

export class LspDaemon {
  private backends: LspBackend[];
  /** TypeScript backend — also handles workspace/symbol queries */
  private tsBackend: LspBackend;
  private server: Server | null = null;

  private lastActivity = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private socketPath = SOCKET_PATH,
    private pidPath = PID_PATH,
    private idleTimeoutMs = IDLE_TIMEOUT_MS,
  ) {
    this.tsBackend = new LspBackend(
      "typescript", "typescript-language-server", ["--stdio"],
      TS_EXTENSIONS, STANDARD_CAPABILITIES, "TS",
    );
    const bashBackend = new LspBackend(
      "bash", "bash-language-server", ["start"],
      BASH_EXTENSIONS, STANDARD_CAPABILITIES, "",
    );
    const nilBackend = new LspBackend(
      "nil", "nil", [],
      NIX_EXTENSIONS, STANDARD_CAPABILITIES, "",
    );
    this.backends = [this.tsBackend, bashBackend, nilBackend];
  }

  /** Return the backend that handles this file, falling back to TypeScript. */
  private getBackend(filePath: string): LspBackend {
    return this.backends.find((b) => b.handles(filePath)) ?? this.tsBackend;
  }

  // ─── Startup ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    writeFileSync(this.pidPath, String(process.pid), "utf8");

    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }

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
    socket.setEncoding("utf8");

    socket.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.handleRequest(socket, line);
      }
    });

    socket.on("error", () => socket.destroy());
  }

  private async handleRequest(socket: Socket, line: string): Promise<void> {
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

    socket.write(serializeResponse(response));
  }

  private async dispatch(req: DaemonRequest): Promise<DaemonResponse> {
    const deps: HandlerDeps = {
      getBackend: (p) => this.getBackend(p),
      tsBackend: this.tsBackend,
      backends: this.backends,
      lastActivity: this.lastActivity,
    };

    switch (req.action) {
      case "diagnostics": return handleDiagnostics(req, deps);
      case "hover":       return handleHover(req, deps);
      case "definition":  return handleDefinition(req, deps);
      case "references":  return handleReferences(req, deps);
      case "symbols":     return handleSymbols(req, deps);
      case "status":      return handleStatus(req, deps);
      case "shutdown":
        this.shutdown();
        return okResponse(req.id, {
          action: "status", running: false, projects: [], openFiles: [], watchedFiles: 0, idleMs: 0,
        } as StatusResult);
      default:
        return errorResponse(req.id, `Unknown action: ${(req as any).action}`);
    }
  }

  // ─── Idle / Shutdown ─────────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown(), this.idleTimeoutMs);
  }

  shutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const backend of this.backends) backend.shutdown();
    this.server?.close();
    try { unlinkSync(this.socketPath); } catch {}
    try { unlinkSync(this.pidPath); } catch {}
    process.exit(0);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const daemon = new LspDaemon();
  process.on("SIGTERM", () => daemon.shutdown());
  process.on("SIGINT", () => daemon.shutdown());
  daemon.start().catch((err) => {
    console.error("Daemon failed to start:", err);
    process.exit(1);
  });
}
