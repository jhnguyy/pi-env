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
import { unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Effect, Result } from "effect";

import { LspBackend } from "./backend";
import { BACKEND_CONFIGS } from "./backend-configs";
import { FileCache } from "./file-cache";
import type { HandlerBackend } from "./handlers";
import { createDaemonRequestExecutor } from "./daemon-request";
import { parseRequest, serializeResponse, errorResponse, SOCKET_PATH, PID_PATH } from "./protocol";
import type { DaemonRequest, DaemonResponse } from "./protocol";
import { removeStaleArtifact } from "./socket-artifacts";
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
  private state: "new" | "starting" | "running" | "stopping" | "stopped" = "new";
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private readonly tasks = new Set<Promise<void>>();
  private readonly shutdownSockets = new Set<Socket>();
  private ownsPid = false;
  private ownsSocket = false;

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

  /** One lifetime: startup owns partial acquisition cleanup; stopping cannot restart it. */
  start(): Promise<void> {
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.reject(new Error("Daemon is stopping or stopped"));
    }
    if (this.startPromise) return this.startPromise;
    this.state = "starting";
    this.startPromise = Promise.resolve().then(() => this.startOwned());
    return this.startPromise;
  }

  private async startOwned(): Promise<void> {
    try {
      if (this.state !== "starting") throw new Error("Daemon startup stopped");
      writeFileSync(this.pidPath, String(process.pid), "utf8");
      this.ownsPid = true;
      removeStaleArtifact(this.socketPath);
      await this.startServer();
      if (this.state !== "starting") throw new Error("Daemon startup stopped");
      this.state = "running";
      this.resetIdleTimer();
    } catch (error) {
      this.closeAdmission();
      try {
        await this.cleanup();
      } catch (cleanupError) {
        // eslint-disable-next-line preserve-caught-error -- Startup is the cause; cleanup failure is retained in errors.
        throw new AggregateError([error, cleanupError], "Daemon startup and cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.ownsSocket = true;
        this.server!.off("error", reject);
        this.server!.on("error", (error) => {
          this.reportBackgroundError("listener failed", error);
          this.superviseShutdown();
        });
        resolve();
      });
    });
  }

  // ─── Connection handling ─────────────────────────────────────────────────────

  private handleConnection(socket: Socket): void {
    if (this.state !== "running") {
      socket.destroy();
      return;
    }
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
        if (line.trim()) this.handleRequest(socket, line);
      }
    });

    socket.on("error", () => socket.destroy());
  }

  private handleRequest(socket: Socket, line: string): void {
    let req: DaemonRequest;
    try {
      req = parseRequest(line);
    } catch {
      this.writeResponse(socket, errorResponse(0, "Invalid request JSON"));
      return;
    }
    if (
      typeof req !== "object" ||
      req === null ||
      Array.isArray(req) ||
      typeof req.action !== "string" ||
      !req.action.trim() ||
      typeof req.id !== "number" ||
      !Number.isFinite(req.id)
    ) {
      this.writeResponse(socket, errorResponse(0, "Invalid request envelope"));
      return;
    }
    if (this.state !== "running") {
      this.writeResponse(socket, errorResponse(req.id, "Daemon is stopping"));
      return;
    }
    this.previousActivity = this.lastActivity;
    this.lastActivity = Date.now();
    this.resetIdleTimer();

    // Admission and task registration precede shutdown, including later frames in this chunk.
    const task = Promise.resolve()
      .then(async () => {
        const response = await this.executeRequest(req);
        this.writeResponse(socket, response);
      })
      .catch((error: unknown) => this.reportBackgroundError("request failed", error));
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task));
    if (req.action === "shutdown") {
      this.shutdownSockets.add(socket);
      this.superviseShutdown();
    }
  }

  private writeResponse(socket: Socket, response: DaemonResponse): void {
    if (!socket.destroyed && !socket.writableEnded) socket.write(serializeResponse(response));
  }

  private reportBackgroundError(event: string, error: unknown): void {
    console.error(`[dev-tools-daemon] ${event}:`, error);
    if (isMain) process.exitCode = 1;
  }

  private superviseShutdown(): void {
    void this.shutdown().catch((error: unknown) =>
      this.reportBackgroundError("shutdown failed", error),
    );
  }

  // ─── Idle / Shutdown ─────────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.state !== "running") return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.superviseShutdown(), this.idleTimeoutMs);
  }

  private closeAdmission(): void {
    this.state = "stopping";
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Close admission synchronously, then drain accepted work without cancelling on disconnect.
   * Acknowledgement and EOF do not confirm resource release; receipt/backpressure never gates cleanup.
   * Shutdown has no hard deadline: requests, filesystem work, or resource release may stay pending.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closeAdmission();
    this.shutdownPromise = (async () => {
      await this.startPromise?.catch(() => {});
      await this.cleanup();
    })();
    return this.shutdownPromise;
  }

  private cleanup(): Promise<void> {
    this.cleanupPromise ??= this.releaseOwned();
    return this.cleanupPromise;
  }

  private async releaseOwned(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (release: () => void | Promise<void>) => {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    };
    await Promise.all(this.tasks);
    for (const socket of this.shutdownSockets) {
      await attempt(() => {
        if (!socket.destroyed) socket.end();
      });
    }
    this.shutdownSockets.clear();
    const settled = await Promise.allSettled(
      this.backends.map((backend) => Promise.resolve().then(() => backend.shutdown())),
    );
    for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
    for (const socket of this.sockets)
      await attempt(() => {
        socket.destroy();
      });
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    // Observe close failure immediately, but do not let a live connection block
    // independent releases. Shutdown still waits for listener completion below.
    const listenerClosed = server?.listening
      ? attempt(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        )
      : Promise.resolve();
    for (const path of [
      this.ownsSocket ? this.socketPath : null,
      this.ownsPid ? this.pidPath : null,
    ]) {
      if (path)
        await attempt(() => {
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        });
    }
    await attempt(() => Effect.runPromise(this.telemetry.disposeEffect));
    await listenerClosed;
    this.state = "stopped";
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Daemon cleanup failed");
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
    const stop = () => {
      void daemon.shutdown().catch((error: unknown) => {
        console.error("[dev-tools-daemon] signal shutdown failed:", error);
        process.exitCode = 1;
      });
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    await daemon.start();
  };
  main().catch((error) => {
    console.error("Daemon failed to start:", error);
    process.exit(1);
  });
}
