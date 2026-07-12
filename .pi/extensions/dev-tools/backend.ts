/**
 * backend.ts — LspBackend: per-language-server subprocess manager.
 */

import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, resolve as resolvePath } from "node:path";

import { Deferred, Effect, Exit, Scope } from "effect";

import { scopedChildProcess } from "../../../src/process/platform.js";
import { serializeMessage, LspParser, type LspMessage } from "./lsp-transport";
import { DocumentManager, MAX_OPEN_DOCUMENTS } from "./document-manager";
import { DiagnosticsCache } from "./diagnostics-cache";
import { pathToUri, toOneBased, severityLabel, truncateMessage } from "./utils";
import type { DiagnosticItem } from "./protocol";
import type { LspBackendConfig } from "./backend-configs";
import { findNodeBinaryLite } from "../_shared/node-bin-lite";

export const LSP_INIT_TIMEOUT_MS = 10_000;
export const LSP_REQUEST_TIMEOUT_MS = 5_000;

export async function findBinary(name: string): Promise<string | null> {
  return findNodeBinaryLite(name, import.meta.url);
}

type Pending = {
  deferred: Deferred.Deferred<LspMessage, Error>;
  timer: ReturnType<typeof setTimeout>;
};

type ListenerSet = {
  parser: LspParser;
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (err: Error) => void;
};

export class LspBackend {
  private lsp: ChildProcess | null = null;
  private scope: Scope.Closeable | null = null;
  private listeners: ListenerSet | null = null;
  private stderrTail = "";
  private lspReady = false;
  private nextLspId = 1;
  private pendingLsp = new Map<number, Pending>();

  readonly diagnostics = new DiagnosticsCache();
  private readonly docManager: DocumentManager;

  private started = false;
  private startPromise: Promise<void> | null = null;
  private unavailable: string | null = null;
  private shuttingDown: Promise<void> | null = null;
  private scopeClosePromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;

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

  constructor(config: LspBackendConfig) {
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

  handles(filePath: string): boolean { return this.extensionMap.has(extname(filePath)); }
  getLanguageId(filePath: string): string { return this.extensionMap.get(extname(filePath)) ?? this.name; }

  findProjectRoot(filePath: string): string | null {
    if (this.rootMarkers.length === 0) return null;
    let dir = dirname(filePath);
    while (true) {
      for (const marker of this.rootMarkers) if (existsSync(resolvePath(dir, marker))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  getProjectRoot(filePath: string): string { return this.docManager.getProjectRoot(filePath); }
  get isRunning(): boolean { return this.lspReady; }
  get openUris(): string[] { return this.docManager.openUris; }
  get projectRoots(): string[] { return this.docManager.projectRoots; }

  async ensureStarted(): Promise<void> {
    if (this.started && this.lspReady) return;
    if (this.unavailable) throw new Error(this.unavailable);
    if (this.shuttingDown) throw new Error(`${this.name} LSP is shutting down`);
    if (this.startPromise) return this.startPromise;
    const generation = this.lifecycleGeneration;
    this.startPromise = this.doStart(generation).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async doStart(generation: number): Promise<void> {
    if (this.scopeClosePromise) await Promise.resolve(this.scopeClosePromise);
    this.assertStartupGeneration(generation);
    let command = this.launchCommand;
    let args = this.launchArgs;
    if (this.launchCommand === this.binaryName) {
      const bin = await findBinary(this.binaryName);
      if (!bin) {
        this.unavailable = `${this.name} language server (${this.binaryName}) is not installed — ` +
          `.${this.extensionMap.keys().next().value?.slice(1) ?? this.name} language intelligence unavailable`;
        console.warn(`[dev-tools-daemon] WARNING: ${this.unavailable}`);
        throw new Error(this.unavailable);
      }
      command = bin;
      args = this.binaryArgs;
      this.assertStartupGeneration(generation);
    }

    const scope = await Effect.runPromise(Scope.make());
    if (generation !== this.lifecycleGeneration) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw new Error(`${this.name} LSP startup cancelled`);
    }
    this.scope = scope;
    try {
      const env = this.nodeExecPathShim
        ? { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--import ${this.nodeExecPathShim}` }
        : process.env;
      const proc = await Effect.runPromise(Scope.provide(scopedChildProcess(command, args, { stdio: ["pipe", "pipe", "pipe"], env }), scope));
      this.assertStartupGeneration(generation);
      this.attach(proc);
      await this.initialize();
      this.assertStartupGeneration(generation);
      this.lspReady = true;
      this.started = true;
    } catch (cause) {
      await this.shutdownWithError(cause instanceof Error ? cause : new Error(String(cause)));
      throw cause;
    }
  }

  private assertStartupGeneration(generation: number): void {
    if (generation !== this.lifecycleGeneration) throw new Error(`${this.name} LSP startup cancelled`);
  }

  private attach(proc: ChildProcess): void {
    this.lsp = proc;
    const parser = new LspParser((msg) => this.onLspMessage(msg));
    const onStdout = (chunk: Buffer) => parser.push(chunk);
    const onStderr = (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const stderr = this.stderrTail.trim();
      this.failAndReset(new Error(`${this.name} LSP exited${signal ? ` by ${signal}` : code == null ? "" : ` with code ${code}`}${stderr ? `: ${stderr}` : ""}`));
    };
    const onError = (err: Error) => this.failAndReset(err);
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.once("exit", onExit);
    proc.once("error", onError);
    this.listeners = { parser, onStdout, onStderr, onExit, onError };
  }

  private async initialize(): Promise<void> {
    const initId = this.nextLspId++;
    const deferred = Effect.runSync(Deferred.make<LspMessage, Error>());
    const timer = setTimeout(() => this.failRequest(initId, new Error(`${this.name} LSP initialize timed out`)), LSP_INIT_TIMEOUT_MS);
    this.pendingLsp.set(initId, { deferred, timer });
    this.sendLsp({
      jsonrpc: "2.0", id: initId, method: "initialize",
      params: { processId: process.pid, rootUri: null, capabilities: this.lspCapabilities, initializationOptions: this.initializationOptions, workspaceFolders: null },
    });
    await Effect.runPromise(Deferred.await(deferred));
    this.sendLsp({ jsonrpc: "2.0", method: "initialized", params: {} });
  }

  async ensureFile(absolutePath: string): Promise<string> {
    await this.ensureStarted();
    const { uri, notification, isNewRoot, projectRoot } = this.docManager.ensure(absolutePath);
    if (isNewRoot) this.addWorkspaceFolder(projectRoot);
    if (notification) {
      this.diagnostics.delete(uri);
      this.sendLsp({ jsonrpc: "2.0", method: `textDocument/${notification.type}`, params: notification.params });
    }
    for (const evictedUri of this.docManager.evict(MAX_OPEN_DOCUMENTS)) {
      this.sendLsp({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: evictedUri } } });
      this.diagnostics.delete(evictedUri);
    }
    return uri;
  }

  closeFile(absolutePath: string): string | null {
    const uri = this.docManager.close(absolutePath);
    if (!uri) return null;
    this.sendLsp({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } });
    this.diagnostics.delete(uri);
    return uri;
  }

  async ensureReady(): Promise<void> { await this.ensureStarted(); }

  private addWorkspaceFolder(root: string): void {
    this.sendLsp({ jsonrpc: "2.0", method: "workspace/didChangeWorkspaceFolders", params: { event: { added: [{ uri: pathToUri(root), name: root.split("/").pop() ?? root }], removed: [] } } });
  }

  async waitForDiagnostics(uri: string): Promise<void> { return this.diagnostics.waitForSettled(uri); }
  getDiagnostics(uri: string): DiagnosticItem[] { return this.diagnostics.get(uri); }

  async lspRequest(method: string, params: unknown): Promise<LspMessage | null> {
    if (!this.lsp || !this.lspReady) return null;
    const id = this.nextLspId++;
    const deferred = Effect.runSync(Deferred.make<LspMessage, Error>());
    const timer = setTimeout(() => this.failRequest(id, new Error(`${this.name} LSP request timed out: ${method}`)), LSP_REQUEST_TIMEOUT_MS);
    this.pendingLsp.set(id, { deferred, timer });
    this.sendLsp({ jsonrpc: "2.0", id, method, params });
    try {
      return await Effect.runPromise(Deferred.await(deferred));
    } catch {
      return null;
    }
  }

  private onLspMessage(msg: LspMessage): void {
    if (msg.method === "textDocument/publishDiagnostics") { this.onDiagnostics(msg.params as { uri: string; diagnostics: any[] }); return; }
    if (msg.id != null) this.succeedRequest(msg.id as number, msg);
  }

  private onDiagnostics(params: { uri: string; diagnostics: any[] }): void {
    const prefix = this.codePrefix;
    const items: DiagnosticItem[] = params.diagnostics.map((d) => {
      const pos = toOneBased(d.range.start.line, d.range.start.character);
      const rawCode = d.code != null ? String(d.code) : "";
      const code = rawCode && prefix && !rawCode.startsWith(prefix) ? `${prefix}${rawCode}` : rawCode;
      return { line: pos.line, character: pos.character, severity: severityLabel(d.severity), code, message: truncateMessage(d.message) };
    });
    this.diagnostics.publish(params.uri, items);
  }

  private sendLsp(msg: LspMessage): void {
    if (!this.lsp?.stdin || this.lsp.stdin.destroyed) return;
    this.lsp.stdin.write(serializeMessage(msg));
  }

  private succeedRequest(id: number, msg: LspMessage): void {
    const pending = this.pendingLsp.get(id);
    if (!pending) return;
    this.pendingLsp.delete(id);
    clearTimeout(pending.timer);
    Effect.runSync(Deferred.succeed(pending.deferred, msg));
  }

  private failRequest(id: number, err: Error): void {
    const pending = this.pendingLsp.get(id);
    if (!pending) return;
    this.pendingLsp.delete(id);
    clearTimeout(pending.timer);
    Effect.runSync(Deferred.fail(pending.deferred, err));
  }

  private failAllPending(err: Error): void {
    const pending = [...this.pendingLsp.entries()];
    this.pendingLsp.clear();
    for (const [, record] of pending) {
      clearTimeout(record.timer);
      Effect.runSync(Deferred.fail(record.deferred, err));
    }
  }

  private removeChildListeners(): void {
    if (!this.lsp || !this.listeners) return;
    this.lsp.stdout?.off("data", this.listeners.onStdout);
    this.lsp.stderr?.off("data", this.listeners.onStderr);
    this.lsp.off("exit", this.listeners.onExit);
    this.lsp.off("error", this.listeners.onError);
    this.listeners = null;
  }

  private resetServerState(): void {
    this.started = false;
    this.lspReady = false;
    this.stderrTail = "";
    this.lsp = null;
    this.docManager.clear();
    this.diagnostics.clear();
  }

  private failAndReset(err: Error): void {
    this.failAllPending(err);
    this.removeChildListeners();
    void this.closeScope();
    this.resetServerState();
  }

  private async shutdownWithError(err: Error): Promise<void> {
    this.failAllPending(err);
    await this.closeScope();
    this.removeChildListeners();
    this.resetServerState();
  }

  private closeScope(): Promise<void> {
    if (this.scopeClosePromise) return this.scopeClosePromise;
    const scope = this.scope;
    this.scope = null;
    if (!scope) return Promise.resolve();
    this.scopeClosePromise = Effect.runPromise(Scope.close(scope, Exit.void))
      .finally(() => { this.scopeClosePromise = null; });
    return this.scopeClosePromise;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    this.lifecycleGeneration++;
    const startup = this.startPromise;
    this.shuttingDown = (async () => {
      const proc = this.lsp;
      if (proc && this.lspReady) {
        try { this.sendLsp({ jsonrpc: "2.0", id: this.nextLspId++, method: "shutdown", params: null }); } catch {}
        try { this.sendLsp({ jsonrpc: "2.0", method: "exit", params: null }); } catch {}
      }
      this.failAllPending(new Error(`${this.name} LSP shutdown`));
      await this.closeScope();
      if (startup) await startup.catch(() => {});
      await this.closeScope();
      this.removeChildListeners();
      this.resetServerState();
    })().finally(() => { this.shuttingDown = null; });
    return this.shuttingDown;
  }
}
