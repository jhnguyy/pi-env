/**
 * backend.ts — LspBackend: Effect-owned per-language-server subprocess manager.
 */

import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, resolve as resolvePath } from "node:path";

import { Data, Deferred, Effect, Exit, Scope } from "effect";

import { scopedChildProcess } from "../../../src/process/platform.js";
import { serializeMessage, LspParser, type LspMessage } from "./lsp-transport";
import { DocumentManager, MAX_OPEN_DOCUMENTS } from "./document-manager";
import { DiagnosticsCache } from "./diagnostics-cache";
import { pathToUri, toOneBased, severityLabel, truncateMessage } from "./utils";
import type { DiagnosticItem } from "./protocol";
import type { LspBackendConfig } from "./backend-configs";
import { findNodeBinaryLite } from "../_shared/node-bin-lite";
import {
  noopToolingTelemetryRuntime,
  type ToolingTelemetryRuntime,
} from "../../../src/telemetry/tooling.js";
import {
  DevToolsOperation,
  DevToolsSpanName,
  inheritDevToolsParentSpan,
  withSafeDevToolsSpan,
} from "./telemetry";

export const LSP_INIT_TIMEOUT_MS = 10_000;
export const LSP_REQUEST_TIMEOUT_MS = 5_000;

export async function findBinary(name: string): Promise<string | null> {
  return findNodeBinaryLite(name, import.meta.url);
}

type Pending = {
  deferred: Deferred.Deferred<LspMessage, LspBackendError>;
  timer: ReturnType<typeof setTimeout>;
  generation: number;
};

type ListenerSet = {
  parser: LspParser;
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (err: Error) => void;
};

type BackendResource = {
  scope?: Scope.Closeable;
  process?: ChildProcess;
  listeners?: ListenerSet;
  stderrTail: string;
};

type BackendLifecycle =
  | { _tag: "idle"; generation: number }
  | { _tag: "unavailable"; generation: number; message: string }
  | {
      _tag: "starting";
      generation: number;
      ready: Deferred.Deferred<void, LspBackendError>;
      resource: BackendResource;
    }
  | { _tag: "running"; generation: number; resource: BackendResource }
  | {
      _tag: "stopping";
      generation: number;
      done: Deferred.Deferred<void>;
      resource: BackendResource;
      startup?: Deferred.Deferred<void, LspBackendError>;
    };

export const LspBackendErrorKind = {
  Unavailable: "unavailable",
  ShuttingDown: "shutting_down",
  Lookup: "lookup",
  Startup: "startup",
  Cancelled: "cancelled",
  Initialize: "initialize",
  Request: "request",
  ProcessExit: "process_exit",
  Shutdown: "shutdown",
  Document: "document",
} as const;
export type LspBackendErrorKind =
  (typeof LspBackendErrorKind)[keyof typeof LspBackendErrorKind];

export class LspBackendError extends Data.TaggedError("LspBackendError")<{
  readonly kind: LspBackendErrorKind;
  readonly message: string;
}> {}

function backendError(kind: LspBackendErrorKind, message: string): LspBackendError {
  return new LspBackendError({ kind, message });
}

function backendErrorFromCause(
  kind: LspBackendErrorKind,
  prefix: string,
  cause: unknown,
): LspBackendError {
  const detail =
    cause instanceof Error
      ? cause.message
      : typeof cause === "object" && cause !== null && "message" in cause
        ? String(cause.message)
        : String(cause);
  return backendError(kind, `${prefix}: ${detail}`.slice(0, 4_000));
}

function emptyResource(): BackendResource {
  return { stderrTail: "" };
}

export class LspBackend {
  private lifecycle: BackendLifecycle = { _tag: "idle", generation: 0 };
  private nextLspId = 1;
  private readonly pendingLsp = new Map<number, Pending>();

  readonly diagnostics = new DiagnosticsCache();
  private readonly docManager: DocumentManager;

  readonly name: string;
  private readonly binaryName: string;
  private readonly binaryArgs: string[];
  private readonly launchCommand: string;
  private readonly launchArgs: string[];
  private readonly nodeExecPathShim: string | undefined;
  private readonly extensionMap: Map<string, string>;
  private readonly lspCapabilities: object;
  private readonly initializationOptions: object | undefined;
  private readonly codePrefix: string;
  private readonly rootMarkers: string[];
  readonly supportsWorkspaceSymbols: boolean;

  constructor(
    config: LspBackendConfig,
    private readonly telemetry: ToolingTelemetryRuntime = noopToolingTelemetryRuntime,
  ) {
    this.name = config.name;
    this.binaryName = config.binaryName;
    this.binaryArgs = config.binaryArgs;
    this.launchCommand = config.launchCommand;
    this.launchArgs = config.launchArgs;
    this.nodeExecPathShim = config.nodeExecPathShim;
    this.extensionMap = config.extensions;
    this.lspCapabilities = config.capabilities;
    this.initializationOptions = config.initializationOptions;
    this.codePrefix = config.codePrefix;
    this.rootMarkers = config.rootMarkers;
    this.supportsWorkspaceSymbols = config.supportsWorkspaceSymbols;
    this.docManager = new DocumentManager(
      (path) => this.getLanguageId(path),
      (path) => this.findProjectRoot(path),
    );
  }

  private provideTelemetry<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return this.telemetry.provide(inheritDevToolsParentSpan(effect));
  }

  handles(filePath: string): boolean {
    return this.extensionMap.has(extname(filePath));
  }

  getLanguageId(filePath: string): string {
    return this.extensionMap.get(extname(filePath)) ?? this.name;
  }

  findProjectRoot(filePath: string): string | null {
    if (this.rootMarkers.length === 0) return null;
    let dir = dirname(filePath);
    while (true) {
      for (const marker of this.rootMarkers) {
        if (existsSync(resolvePath(dir, marker))) return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  getProjectRoot(filePath: string): string {
    return this.docManager.getProjectRoot(filePath);
  }

  get isRunning(): boolean {
    return this.lifecycle._tag === "running";
  }

  get openUris(): string[] {
    return this.docManager.openUris;
  }

  get projectRoots(): string[] {
    return this.docManager.projectRoots;
  }

  ensureStartedEffect(): Effect.Effect<void, LspBackendError> {
    return Effect.suspend(() => {
      switch (this.lifecycle._tag) {
        case "running":
          return Effect.void;
        case "starting":
          return Deferred.await(this.lifecycle.ready);
        case "stopping":
          return Effect.fail(
            backendError(LspBackendErrorKind.ShuttingDown, `${this.name} LSP is shutting down`),
          );
        case "unavailable":
          return Effect.fail(
            backendError(LspBackendErrorKind.Unavailable, this.lifecycle.message),
          );
        case "idle": {
          const ready = Deferred.makeUnsafe<void, LspBackendError>();
          const generation = this.lifecycle.generation + 1;
          this.lifecycle = {
            _tag: "starting",
            generation,
            ready,
            resource: emptyResource(),
          };
          return withSafeDevToolsSpan(
            this.telemetry.diagnostics,
            DevToolsSpanName.BackendStartup,
            { operation: DevToolsOperation.Startup, backend: this.name },
            this.startEffect(generation, ready),
            (error) => error.kind,
          );
        }
      }
    });
  }

  ensureStarted(): Promise<void> {
    return Effect.runPromise(this.provideTelemetry(this.ensureStartedEffect()));
  }

  private startEffect(
    generation: number,
    ready: Deferred.Deferred<void, LspBackendError>,
  ): Effect.Effect<void, LspBackendError> {
    const owned = emptyResource();
    const start = Effect.gen({ self: this }, function* () {
      let command = this.launchCommand;
      let args = this.launchArgs;
      if (command === this.binaryName) {
        const binary = yield* Effect.tryPromise({
          try: () => findBinary(this.binaryName),
          catch: (cause) =>
            backendErrorFromCause(
              LspBackendErrorKind.Lookup,
              `${this.name} language server lookup failed`,
              cause,
            ),
        });
        if (!binary) {
          const extension = this.extensionMap.keys().next().value?.slice(1) ?? this.name;
          const message =
            `${this.name} language server (${this.binaryName}) is not installed — ` +
            `.${extension} language intelligence unavailable`;
          console.warn(`[dev-tools-daemon] WARNING: ${message}`);
          return yield* backendError(LspBackendErrorKind.Unavailable, message);
        }
        command = binary;
        args = this.binaryArgs;
      }

      yield* this.assertStartingEffect(generation);
      const scope = yield* Scope.make();
      owned.scope = scope;
      yield* this.installResourceEffect(generation, { scope });

      const env = this.nodeExecPathShim
        ? {
            ...process.env,
            NODE_OPTIONS:
              `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}` +
              `--import ${this.nodeExecPathShim}`,
          }
        : process.env;
      const child = yield* Scope.provide(
        scopedChildProcess(command, args, { stdio: ["pipe", "pipe", "pipe"], env }),
        scope,
      ).pipe(
        Effect.mapError((cause) =>
          backendErrorFromCause(
            LspBackendErrorKind.Startup,
            `${this.name} language server failed to start`,
            cause,
          ),
        ),
      );
      owned.process = child;
      yield* this.installResourceEffect(generation, { process: child });

      const listeners = yield* Effect.try({
        try: () => this.attach(child, generation),
        catch: (cause) =>
          backendErrorFromCause(
            LspBackendErrorKind.Startup,
            `${this.name} language server listener setup failed`,
            cause,
          ),
      });
      owned.listeners = listeners;
      yield* this.installResourceEffect(generation, { listeners });
      yield* withSafeDevToolsSpan(
        this.telemetry.diagnostics,
        DevToolsSpanName.BackendInitialize,
        { operation: DevToolsOperation.Initialize, backend: this.name, method: "initialize" },
        this.initializeEffect(generation),
        (error) => error.kind,
      );
      yield* this.publishRunningEffect(generation, ready);
    });

    return start.pipe(
      Effect.tapError((error) => this.failStartupEffect(generation, ready, owned, error)),
    );
  }

  private assertStartingEffect(generation: number): Effect.Effect<void, LspBackendError> {
    return Effect.suspend(() =>
      this.lifecycle._tag === "starting" && this.lifecycle.generation === generation
        ? Effect.void
        : Effect.fail(
            backendError(LspBackendErrorKind.Cancelled, `${this.name} LSP startup cancelled`),
          ),
    );
  }

  private installResourceEffect(
    generation: number,
    patch: Partial<BackendResource>,
  ): Effect.Effect<void, LspBackendError> {
    return Effect.suspend(() => {
      if (this.lifecycle._tag !== "starting" || this.lifecycle.generation !== generation) {
        return Effect.fail(
          backendError(LspBackendErrorKind.Cancelled, `${this.name} LSP startup cancelled`),
        );
      }
      this.lifecycle = {
        ...this.lifecycle,
        resource: { ...this.lifecycle.resource, ...patch },
      };
      return Effect.void;
    });
  }

  private publishRunningEffect(
    generation: number,
    ready: Deferred.Deferred<void, LspBackendError>,
  ): Effect.Effect<void, LspBackendError> {
    return Effect.suspend(() => {
      if (this.lifecycle._tag !== "starting" || this.lifecycle.generation !== generation) {
        return Effect.fail(
          backendError(LspBackendErrorKind.Cancelled, `${this.name} LSP startup cancelled`),
        );
      }
      this.lifecycle = {
        _tag: "running",
        generation,
        resource: this.lifecycle.resource,
      };
      return Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
    });
  }

  private failStartupEffect(
    generation: number,
    ready: Deferred.Deferred<void, LspBackendError>,
    owned: BackendResource,
    error: LspBackendError,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      let ownedStopping:
        | {
            done: Deferred.Deferred<void>;
            stoppingGeneration: number;
            unavailable: boolean;
          }
        | undefined;
      if (this.lifecycle._tag === "starting" && this.lifecycle.generation === generation) {
        const done = Deferred.makeUnsafe<void>();
        const stoppingGeneration = generation + 1;
        this.lifecycle = {
          _tag: "stopping",
          generation: stoppingGeneration,
          done,
          resource: this.lifecycle.resource,
          startup: ready,
        };
        ownedStopping = {
          done,
          stoppingGeneration,
          unavailable: error.kind === LspBackendErrorKind.Unavailable,
        };
        this.resetCaches();
      }
      yield* this.failAllPendingEffect(error, generation);
      yield* Deferred.fail(ready, error).pipe(Effect.ignore);
      yield* this.cleanupResourceEffect(owned);
      if (ownedStopping) {
        yield* Effect.sync(() => {
          if (
            this.lifecycle._tag === "stopping" &&
            this.lifecycle.done === ownedStopping.done
          ) {
            this.lifecycle = ownedStopping.unavailable
              ? {
                  _tag: "unavailable",
                  generation: ownedStopping.stoppingGeneration,
                  message: error.message,
                }
              : { _tag: "idle", generation: ownedStopping.stoppingGeneration };
          }
        });
        yield* Deferred.succeed(ownedStopping.done, undefined).pipe(Effect.ignore);
      }
    });
  }

  private attach(process: ChildProcess, generation: number): ListenerSet {
    const parser = new LspParser((message) => {
      Effect.runFork(this.onLspMessageEffect(message, generation));
    });
    const onStdout = (chunk: Buffer) => parser.push(chunk);
    const onStderr = (chunk: Buffer) => this.appendStderr(generation, chunk);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      Effect.runFork(this.onProcessExitEffect(generation, code, signal));
    };
    const onError = (error: Error) => {
      Effect.runFork(
        this.failAndResetEffect(
          generation,
          backendErrorFromCause(
            LspBackendErrorKind.ProcessExit,
            `${this.name} LSP process failed`,
            error,
          ),
        ),
      );
    };
    process.stdout?.on("data", onStdout);
    process.stderr?.on("data", onStderr);
    process.once("exit", onExit);
    process.once("error", onError);
    return { parser, onStdout, onStderr, onExit, onError };
  }

  private appendStderr(generation: number, chunk: Buffer): void {
    if (
      (this.lifecycle._tag === "starting" || this.lifecycle._tag === "running") &&
      this.lifecycle.generation === generation
    ) {
      this.lifecycle.resource.stderrTail = (
        this.lifecycle.resource.stderrTail + chunk.toString("utf8")
      ).slice(-4000);
    }
  }

  private onProcessExitEffect(
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (
        (this.lifecycle._tag !== "starting" && this.lifecycle._tag !== "running") ||
        this.lifecycle.generation !== generation
      ) {
        return Effect.void;
      }
      const stderr = this.lifecycle.resource.stderrTail.trim();
      return this.failAndResetEffect(
        generation,
        backendError(
          LspBackendErrorKind.ProcessExit,
          `${this.name} LSP exited${
            signal ? ` by ${signal}` : code == null ? "" : ` with code ${code}`
          }${stderr ? `: ${stderr}` : ""}`,
        ),
      );
    });
  }

  private initializeEffect(generation: number): Effect.Effect<void, LspBackendError> {
    return Effect.gen({ self: this }, function* () {
      const id = this.nextLspId++;
      const deferred = Deferred.makeUnsafe<LspMessage, LspBackendError>();
      this.addPending(
        id,
        deferred,
        generation,
        LSP_INIT_TIMEOUT_MS,
        backendError(
          LspBackendErrorKind.Initialize,
          `${this.name} LSP initialize timed out`,
        ),
      );
      yield* Effect.try({
        try: () =>
          this.sendLsp(
            {
              jsonrpc: "2.0",
              id,
              method: "initialize",
              params: {
                processId: process.pid,
                rootUri: null,
                capabilities: this.lspCapabilities,
                initializationOptions: this.initializationOptions,
                workspaceFolders: null,
              },
            },
            generation,
          ),
        catch: (cause) =>
          backendErrorFromCause(
            LspBackendErrorKind.Initialize,
            `${this.name} LSP initialize write failed`,
            cause,
          ),
      });
      yield* Deferred.await(deferred);
      yield* this.assertStartingEffect(generation);
      this.sendLsp({ jsonrpc: "2.0", method: "initialized", params: {} }, generation);
    });
  }

  ensureFileEffect(absolutePath: string): Effect.Effect<string, LspBackendError> {
    return this.ensureStartedEffect().pipe(
      Effect.andThen(
        Effect.try({
          try: () => {
            const { uri, notification, isNewRoot, projectRoot } =
              this.docManager.ensure(absolutePath);
            if (isNewRoot) this.addWorkspaceFolder(projectRoot);
            if (notification) {
              this.diagnostics.delete(uri);
              this.sendLsp({
                jsonrpc: "2.0",
                method: `textDocument/${notification.type}`,
                params: notification.params,
              });
            }
            for (const evictedUri of this.docManager.evict(MAX_OPEN_DOCUMENTS)) {
              this.sendLsp({
                jsonrpc: "2.0",
                method: "textDocument/didClose",
                params: { textDocument: { uri: evictedUri } },
              });
              this.diagnostics.delete(evictedUri);
            }
            return uri;
          },
          catch: (cause) =>
            backendErrorFromCause(
              LspBackendErrorKind.Document,
              `${this.name} document open failed`,
              cause,
            ),
        }),
      ),
    );
  }

  ensureFile(absolutePath: string): Promise<string> {
    return Effect.runPromise(this.provideTelemetry(this.ensureFileEffect(absolutePath)));
  }

  closeFile(absolutePath: string): string | null {
    const uri = this.docManager.close(absolutePath);
    if (!uri) return null;
    this.sendLsp({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    });
    this.diagnostics.delete(uri);
    return uri;
  }

  ensureReady(): Promise<void> {
    return Effect.runPromise(this.provideTelemetry(this.ensureStartedEffect()));
  }

  private addWorkspaceFolder(root: string): void {
    this.sendLsp({
      jsonrpc: "2.0",
      method: "workspace/didChangeWorkspaceFolders",
      params: {
        event: {
          added: [{ uri: pathToUri(root), name: root.split("/").pop() ?? root }],
          removed: [],
        },
      },
    });
  }

  waitForDiagnostics(uri: string): Promise<void> {
    return this.diagnostics.waitForSettled(uri);
  }

  getDiagnostics(uri: string): DiagnosticItem[] {
    return this.diagnostics.get(uri);
  }

  lspRequestEffect(method: string, params: unknown): Effect.Effect<LspMessage | null> {
    return Effect.suspend(() => {
      if (this.lifecycle._tag !== "running") return Effect.succeed(null);
      const generation = this.lifecycle.generation;
      const id = this.nextLspId++;
      const deferred = Deferred.makeUnsafe<LspMessage, LspBackendError>();
      this.addPending(
        id,
        deferred,
        generation,
        LSP_REQUEST_TIMEOUT_MS,
        backendError(
          LspBackendErrorKind.Request,
          `${this.name} LSP request timed out: ${method}`,
        ),
      );
      const send = Effect.try({
        try: () => this.sendLsp({ jsonrpc: "2.0", id, method, params }, generation),
        catch: (cause) =>
          backendErrorFromCause(
            LspBackendErrorKind.Request,
            `${this.name} LSP request write failed`,
            cause,
          ),
      }).pipe(
        Effect.tapError((error) => this.failRequestEffect(id, error, generation)),
      );
      const request = send.pipe(Effect.andThen(Deferred.await(deferred)));
      return withSafeDevToolsSpan(
        this.telemetry.diagnostics,
        DevToolsSpanName.BackendRequest,
        { operation: DevToolsOperation.Request, backend: this.name, method },
        request,
        (error) => error.kind,
      ).pipe(Effect.catch(() => Effect.succeed(null)));
    });
  }

  lspRequest(method: string, params: unknown): Promise<LspMessage | null> {
    return Effect.runPromise(this.provideTelemetry(this.lspRequestEffect(method, params)));
  }

  private onLspMessageEffect(message: LspMessage, generation: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (
        (this.lifecycle._tag !== "starting" && this.lifecycle._tag !== "running") ||
        this.lifecycle.generation !== generation
      ) {
        return Effect.void;
      }
      if (message.method === "textDocument/publishDiagnostics") {
        return Effect.sync(() =>
          this.onDiagnostics(message.params as { uri: string; diagnostics: any[] }),
        );
      }
      return message.id == null
        ? Effect.void
        : this.succeedRequestEffect(message.id as number, message, generation);
    });
  }

  private onDiagnostics(params: { uri: string; diagnostics: any[] }): void {
    const prefix = this.codePrefix;
    const items: DiagnosticItem[] = params.diagnostics.map((diagnostic) => {
      const position = toOneBased(
        diagnostic.range.start.line,
        diagnostic.range.start.character,
      );
      const rawCode = diagnostic.code != null ? String(diagnostic.code) : "";
      const code =
        rawCode && prefix && !rawCode.startsWith(prefix) ? `${prefix}${rawCode}` : rawCode;
      return {
        line: position.line,
        character: position.character,
        severity: severityLabel(diagnostic.severity),
        code,
        message: truncateMessage(diagnostic.message),
      };
    });
    this.diagnostics.publish(params.uri, items);
  }

  private sendLsp(message: LspMessage, generation?: number): void {
    const state = this.lifecycle;
    if (state._tag !== "starting" && state._tag !== "running") return;
    if (generation !== undefined && state.generation !== generation) return;
    const stdin = state.resource.process?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(serializeMessage(message));
  }

  private addPending(
    id: number,
    deferred: Deferred.Deferred<LspMessage, LspBackendError>,
    generation: number,
    timeoutMs: number,
    timeoutError: LspBackendError,
  ): void {
    const timer = setTimeout(() => {
      Effect.runFork(this.failRequestEffect(id, timeoutError, generation));
    }, timeoutMs);
    this.pendingLsp.set(id, { deferred, timer, generation });
  }

  private takePending(id: number, generation?: number): Pending | undefined {
    const pending = this.pendingLsp.get(id);
    if (!pending || (generation !== undefined && pending.generation !== generation)) {
      return undefined;
    }
    this.pendingLsp.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private completePendingEffect(
    id: number,
    generation: number | undefined,
    complete: (pending: Pending) => Effect.Effect<unknown>,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const pending = this.takePending(id, generation);
      return pending ? complete(pending).pipe(Effect.asVoid) : Effect.void;
    });
  }

  private succeedRequestEffect(
    id: number,
    message: LspMessage,
    generation: number,
  ): Effect.Effect<void> {
    return this.completePendingEffect(id, generation, (pending) =>
      Deferred.succeed(pending.deferred, message),
    );
  }

  private failRequestEffect(
    id: number,
    error: LspBackendError,
    generation?: number,
  ): Effect.Effect<void> {
    return this.completePendingEffect(id, generation, (pending) =>
      Deferred.fail(pending.deferred, error),
    );
  }

  private failAllPendingEffect(
    error: LspBackendError,
    generation?: number,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const completions: Effect.Effect<unknown>[] = [];
      for (const [id, pending] of this.pendingLsp) {
        if (generation !== undefined && pending.generation !== generation) continue;
        this.pendingLsp.delete(id);
        clearTimeout(pending.timer);
        completions.push(Deferred.fail(pending.deferred, error));
      }
      return Effect.all(completions, { discard: true });
    });
  }

  private detach(resource: BackendResource): void {
    const process = resource.process;
    const listeners = resource.listeners;
    if (!process || !listeners) return;
    process.stdout?.off("data", listeners.onStdout);
    process.stderr?.off("data", listeners.onStderr);
    process.off("exit", listeners.onExit);
    process.off("error", listeners.onError);
  }

  private cleanupResourceEffect(resource: BackendResource): Effect.Effect<void> {
    const detach = Effect.sync(() => this.detach(resource));
    return resource.scope
      ? Scope.close(resource.scope, Exit.void).pipe(Effect.ensuring(detach))
      : detach;
  }

  private resetCaches(): void {
    this.docManager.clear();
    this.diagnostics.clear();
  }

  private failAndResetEffect(
    generation: number,
    error: LspBackendError,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.lifecycle;
      if (
        (state._tag !== "starting" && state._tag !== "running") ||
        state.generation !== generation
      ) {
        return Effect.void;
      }
      const done = Deferred.makeUnsafe<void>();
      const stoppingGeneration = generation + 1;
      this.lifecycle = {
        _tag: "stopping",
        generation: stoppingGeneration,
        done,
        resource: state.resource,
        startup: state._tag === "starting" ? state.ready : undefined,
      };
      this.resetCaches();
      return Effect.gen({ self: this }, function* () {
        yield* this.failAllPendingEffect(error, generation);
        if (state._tag === "starting") {
          yield* Deferred.fail(state.ready, error).pipe(Effect.ignore);
        }
        yield* this.cleanupResourceEffect(state.resource);
        yield* Effect.sync(() => {
          if (this.lifecycle._tag === "stopping" && this.lifecycle.done === done) {
            this.lifecycle = { _tag: "idle", generation: stoppingGeneration };
          }
        });
        yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
      });
    });
  }

  shutdownEffect(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.lifecycle;
      if (state._tag === "idle" || state._tag === "unavailable") return Effect.void;
      if (state._tag === "stopping") return Deferred.await(state.done);

      const done = Deferred.makeUnsafe<void>();
      const wasRunning = state._tag === "running";
      const stopping: Extract<BackendLifecycle, { _tag: "stopping" }> = {
        _tag: "stopping",
        generation: state.generation + 1,
        done,
        resource: state.resource,
        startup: state._tag === "starting" ? state.ready : undefined,
      };
      this.lifecycle = stopping;

      const shutdown = Effect.gen({ self: this }, function* () {
        if (stopping.startup) {
          yield* Deferred.fail(
            stopping.startup,
            backendError(LspBackendErrorKind.Cancelled, `${this.name} LSP startup cancelled`),
          ).pipe(Effect.ignore);
        }
        if (wasRunning) {
          yield* Effect.sync(() => {
            try {
              const stdin = stopping.resource.process?.stdin;
              if (stdin && !stdin.destroyed) {
                stdin.write(
                  serializeMessage({
                    jsonrpc: "2.0",
                    id: this.nextLspId++,
                    method: "shutdown",
                    params: null,
                  }),
                );
                stdin.write(serializeMessage({ jsonrpc: "2.0", method: "exit", params: null }));
              }
            } catch {
              // Scope cleanup below owns process termination.
            }
          });
        }
        yield* this.failAllPendingEffect(
          backendError(LspBackendErrorKind.Shutdown, `${this.name} LSP shutdown`),
        );
        yield* this.cleanupResourceEffect(stopping.resource);
        yield* Effect.sync(() => {
          this.resetCaches();
          if (this.lifecycle._tag === "stopping" && this.lifecycle.done === done) {
            this.lifecycle = { _tag: "idle", generation: stopping.generation };
          }
        });
        yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
      });
      return withSafeDevToolsSpan(
        this.telemetry.diagnostics,
        DevToolsSpanName.BackendShutdown,
        { operation: DevToolsOperation.Shutdown, backend: this.name },
        shutdown,
        () => LspBackendErrorKind.Shutdown,
      );
    });
  }

  shutdown(): Promise<void> {
    return Effect.runPromise(this.provideTelemetry(this.shutdownEffect()));
  }
}
