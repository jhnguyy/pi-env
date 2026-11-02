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
 *   - daemon-request.ts — parsed-request routing, execution, and telemetry
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

import { Effect, Result } from "effect";

import { LspBackend } from "./backend";
import { BACKEND_CONFIGS } from "./backend-configs";
import { FileCache } from "./file-cache";
import type { HandlerBackend } from "./handlers";
import { createDaemonRequestExecutor } from "./daemon-request";
import { parseRequest, serializeResponse, errorResponse, SOCKET_PATH, PID_PATH } from "./protocol";
import type { DaemonRequest, DaemonResponse } from "./protocol";
import { removeStaleArtifact, removeStaleArtifacts } from "./socket-artifacts";
import {
  createToolingTelemetryRuntime,
  noopToolingTelemetryRuntime,
  type ToolingTelemetryRuntime,
} from "../../../src/telemetry/tooling.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const DevToolsEnvironmentName = {
  LspIdleTimeoutMs: "PI_LSP_IDLE_TIMEOUT_MS",
} as const;

function lspIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env[DevToolsEnvironmentName.LspIdleTimeoutMs]);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDLE_TIMEOUT_MS;
}
/** Limit each connection buffer to prevent malformed clients from causing out-of-memory errors. */
const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB

export type ManagedBackend = HandlerBackend & { shutdown(): Promise<void> };

export interface LspDaemonDeps {
  /** Supplied backends transfer shutdown ownership to this daemon. */
  readonly backends: readonly ManagedBackend[];
}

// ─── LspDaemon ───────────────────────────────────────────────────────────────

export class LspDaemon {
  private readonly backends: readonly ManagedBackend[];
  private readonly executeRequest: (req: DaemonRequest) => Promise<DaemonResponse>;
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
    private readonly telemetry: ToolingTelemetryRuntime = noopToolingTelemetryRuntime,
    deps?: LspDaemonDeps,
  ) {
    this.backends =
      deps?.backends ?? BACKEND_CONFIGS.map((config) => new LspBackend(config, telemetry));
    this.executeRequest = createDaemonRequestExecutor({
      backends: this.backends,
      fileCache: this.fileCache,
      getIdleMs: () => Date.now() - this.previousActivity,
      telemetry,
    });
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

    const response = await this.executeRequest(req);

    const serialized = serializeResponse(response);
    if (req.action === "shutdown") {
      socket.end(serialized, () => {
        void this.shutdown();
      });
    } else {
      socket.write(serialized);
    }
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
      await Effect.runPromise(this.telemetry.disposeEffect);
    })();
    return this.shutdownPromise;
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const main = async () => {
    const configured = await Effect.runPromise(
      Effect.result(
        createToolingTelemetryRuntime({
          env: process.env,
          serviceName: "pi-env-dev-tools-daemon",
        }),
      ),
    );
    const telemetry = Result.isFailure(configured)
      ? noopToolingTelemetryRuntime
      : configured.success;
    if (Result.isFailure(configured)) {
      console.warn("[dev-tools-daemon] telemetry configuration invalid; telemetry disabled");
    }
    const daemon = new LspDaemon(undefined, undefined, undefined, telemetry);
    process.on("SIGTERM", () => void daemon.shutdown().then(() => process.exit(0)));
    process.on("SIGINT", () => void daemon.shutdown().then(() => process.exit(0)));
    try {
      await daemon.start();
    } catch (error) {
      await daemon.shutdown();
      throw error;
    }
  };
  main().catch((error) => {
    console.error("Daemon failed to start:", error);
    process.exit(1);
  });
}
