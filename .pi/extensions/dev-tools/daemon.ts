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

interface OwnedResources {
  listener: Server | null;
  pidPath: string | null;
  socketPath: string | null;
}

// ─── LspDaemon ───────────────────────────────────────────────────────────────

export class LspDaemon {
  private readonly backends: readonly ManagedBackend[];
  private readonly executeRequest: (req: DaemonRequest) => Promise<DaemonResponse>;
  private readonly connections = new Map<Socket, { endAfterDrain: boolean }>();
  private fileCache = new FileCache();
  private phase: "closed" | "accepting" | "stopping" = "closed";
  private acquisition: Promise<void> | null = null;
  private startup: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly owned: OwnedResources = { listener: null, pidPath: null, socketPath: null };
  private readonly tasks = new Set<Promise<void>>();

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

  start(): Promise<void> {
    if (this.stopping) {
      return Promise.reject(new Error("Daemon is stopping or stopped"));
    }
    if (!this.startup) {
      // Install both caches before acquisition runs or can call back into this owner.
      this.acquisition = Promise.resolve().then(() => this.acquire());
      this.startup = this.acquisition
        .then(() => {
          if (this.stopping) throw new Error("Daemon startup stopped");
          this.phase = "accepting";
          this.resetIdleTimer();
        })
        .catch((startupFailure: unknown) =>
          this.shutdown().then(
            () => {
              throw startupFailure;
            },
            (cleanupFailure: unknown) => {
              throw new AggregateError(
                [startupFailure, cleanupFailure],
                "Daemon startup and cleanup failed",
                { cause: startupFailure },
              );
            },
          ),
        );
      void this.startup.catch(() => {});
    }
    return this.startup;
  }

  private async acquire(): Promise<void> {
    if (this.stopping) throw new Error("Daemon startup stopped");
    writeFileSync(this.pidPath, String(process.pid), "utf8");
    this.owned.pidPath = this.pidPath;
    removeStaleArtifact(this.socketPath);
    const listener = createServer((socket) => this.handleConnection(socket));
    this.owned.listener = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(this.socketPath, () => {
        this.owned.socketPath = this.socketPath;
        listener.off("error", reject);
        listener.on("error", (error) => {
          this.reportBackgroundError("listener failed", error);
          this.superviseShutdown();
        });
        resolve();
      });
    });
  }

  private async release(): Promise<void> {
    const server = this.owned.listener;
    const errors: unknown[] = [];
    const attempt = async (release: () => void | Promise<void>) => {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    };
    await Promise.all(this.tasks);
    for (const [socket, connection] of this.connections) {
      if (connection.endAfterDrain)
        await attempt(() => {
          if (!socket.destroyed) socket.end();
        });
    }
    const settled = await Promise.allSettled(
      this.backends.map((backend) => Promise.resolve().then(() => backend.shutdown())),
    );
    for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
    for (const socket of this.connections.keys())
      await attempt(() => {
        socket.destroy();
      });
    this.connections.clear();
    // Observe close immediately without blocking independent releases on live connections.
    const listenerClosed = server?.listening
      ? attempt(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        )
      : Promise.resolve();
    for (const path of [this.owned.socketPath, this.owned.pidPath]) {
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
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Daemon cleanup failed");
  }

  // ─── Connection handling ─────────────────────────────────────────────────────

  private handleConnection(socket: Socket): void {
    if (this.phase !== "accepting") {
      socket.destroy();
      return;
    }
    let buf = "";
    this.connections.set(socket, { endAfterDrain: false });
    socket.once("close", () => this.connections.delete(socket));
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
    if (this.phase !== "accepting") {
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
      this.connections.get(socket)!.endAfterDrain = true;
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
    if (this.phase !== "accepting") return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.superviseShutdown(), this.idleTimeoutMs);
  }

  /**
   * Close admission synchronously, then drain accepted work without cancelling on disconnect.
   * Acknowledgement and EOF do not confirm resource release; receipt/backpressure never gates cleanup.
   * Shutdown has no hard deadline: requests, filesystem work, or resource release may stay pending.
   */
  shutdown(): Promise<void> {
    if (!this.stopping) {
      this.phase = "stopping";
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.stopping = Promise.resolve().then(async () => {
        // Never await public startup here: its failure path awaits this finalizer.
        // Raw acquisition only acquires, so it cannot form that dependency cycle.
        await this.acquisition?.catch(() => {});
        await this.release();
      });
      void this.stopping.catch(() => {});
    }
    return this.stopping;
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
