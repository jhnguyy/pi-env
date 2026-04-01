/**
 * backend.ts — LspBackend: per-language-server subprocess manager.
 *
 * Each LspBackend instance manages one language server process (typescript,
 * bash, nil). Backends start lazily on first file request, handle LSP
 * protocol message exchange, and track diagnostics and open documents.
 *
 * Exported by LspDaemon which constructs one instance per backend type.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, resolve as resolvePath } from "node:path";

import { serializeMessage, LspParser, type LspMessage } from "./lsp-transport";
import { DocumentManager, MAX_OPEN_DOCUMENTS } from "./document-manager";
import { DiagnosticsCache } from "./diagnostics-cache";
import { pathToUri, toOneBased, severityLabel, truncateMessage } from "./utils";
import type { DiagnosticItem } from "./protocol";
import type { BackendConfig } from "./backend-configs";

// ─── Constants ────────────────────────────────────────────────────────────────

export const LSP_INIT_TIMEOUT_MS = 10_000;
export const LSP_REQUEST_TIMEOUT_MS = 5_000;

// ─── LSP Capabilities ─────────────────────────────────────────────────────────

export const STANDARD_CAPABILITIES = {
  textDocument: {
    hover: { contentFormat: ["plaintext"] },
    definition: {},
    implementation: {},
    references: {},
    callHierarchy: { dynamicRegistration: false },
    documentSymbol: { hierarchicalDocumentSymbolSupport: false },
    publishDiagnostics: { relatedInformation: false },
  },
  workspace: {
    workspaceFolders: true,
    symbol: {},
  },
};

// ─── Binary discovery ─────────────────────────────────────────────────────────

export async function findBinary(name: string): Promise<string | null> {
  // Check local node_modules first (installed in extension dir)
  const ext = import.meta.dir;
  const local = resolvePath(ext, "node_modules", ".bin", name);
  if (existsSync(local)) return local;

  // Check PATH
  return new Promise((resolve) => {
    const proc = spawn("which", [name], { stdio: "pipe" });
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code: number) => {
      if (code === 0) resolve(out.trim());
      else resolve(null);
    });
  });
}

// ─── LspBackend ───────────────────────────────────────────────────────────────

/**
 * Manages a single language server subprocess.
 * Backends start lazily on first file request.
 */
export class LspBackend {
  private lsp: ChildProcess | null = null;
  private lspReady = false;
  private lspReadyResolvers: Array<() => void> = [];
  private nextLspId = 1;

  // Pending LSP requests: id → { resolve, reject }
  private pendingLsp = new Map<number, { resolve: (msg: LspMessage) => void; reject: (err: Error) => void }>();

  readonly diagnostics = new DiagnosticsCache();
  private readonly docManager: DocumentManager;

  private started = false;
  private startPromise: Promise<void> | null = null;
  /** Cached unavailability reason — set when binary not found; prevents repeated PATH scans. */
  private unavailable: string | null = null;

  /** Display name, e.g. "typescript" or "bash" */
  readonly name: string;
  private readonly binaryName: string;
  private readonly binaryArgs: string[];
  /** File extension → LSP languageId */
  private readonly extensionMap: Map<string, string>;
  private readonly lspCapabilities: object;
  private readonly codePrefix: string;
  private readonly rootMarkers: string[];
  readonly supportsWorkspaceSymbols: boolean;

  constructor(config: BackendConfig) {
    this.name = config.name;
    this.binaryName = config.binaryName;
    this.binaryArgs = config.binaryArgs;
    this.extensionMap = config.extensions;
    this.lspCapabilities = config.capabilities;
    this.codePrefix = config.codePrefix;
    this.rootMarkers = config.rootMarkers;
    this.supportsWorkspaceSymbols = config.supportsWorkspaceSymbols;
    this.docManager = new DocumentManager(
      (path) => this.getLanguageId(path),
      (path) => this.findProjectRoot(path),
    );
  }

  /** Returns true if this backend handles the given file path (by extension). */
  handles(filePath: string): boolean {
    return this.extensionMap.has(extname(filePath));
  }

  /** Get the LSP languageId for a file path. */
  getLanguageId(filePath: string): string {
    return this.extensionMap.get(extname(filePath)) ?? this.name;
  }

  /**
   * Find the project root for a file by walking up the directory tree
   * looking for this backend's root markers. Returns null if none found.
   */
  findProjectRoot(filePath: string): string | null {
    if (this.rootMarkers.length === 0) return null;
    let dir = dirname(filePath);
    while (true) {
      for (const marker of this.rootMarkers) {
        if (existsSync(resolvePath(dir, marker))) return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) return null; // filesystem root
      dir = parent;
    }
  }

  /** Get the project root for a file (cached via DocumentManager). */
  getProjectRoot(filePath: string): string {
    return this.docManager.getProjectRoot(filePath);
  }

  get isRunning(): boolean { return this.lspReady; }
  get openUris(): string[] { return this.docManager.openUris; }
  get projectRoots(): string[] { return this.docManager.projectRoots; }

  // ─── Startup ────────────────────────────────────────────────────────────────

  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.unavailable) throw new Error(this.unavailable);
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart()
      .then(() => { this.started = true; })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const bin = await findBinary(this.binaryName);
    if (!bin) {
      this.unavailable = `${this.name} language server (${this.binaryName}) is not installed — ` +
        `.${this.extensionMap.keys().next().value?.slice(1) ?? this.name} language intelligence unavailable`;
      console.warn(`[dev-tools-daemon] WARNING: ${this.unavailable}`);
      throw new Error(this.unavailable);
    }

    this.lsp = spawn(bin, this.binaryArgs, { stdio: ["pipe", "pipe", "pipe"] });

    const parser = new LspParser((msg) => this.onLspMessage(msg));
    this.lsp.stdout!.on("data", (chunk: Buffer) => parser.push(chunk));
    this.lsp.stderr!.on("data", () => {}); // suppress stderr
    this.lsp.on("exit", () => {
      this.lspReady = false;
      this.lsp = null;
      this.started = false; // allow restart on next request
    });

    // Send initialize request
    const initId = this.nextLspId++;
    const initPromise = new Promise<LspMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLsp.delete(initId);
        reject(new Error(`${this.name} LSP initialize timed out`));
      }, LSP_INIT_TIMEOUT_MS);
      this.pendingLsp.set(initId, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });

    this.sendLsp({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: null,
        capabilities: this.lspCapabilities,
        workspaceFolders: null,
      },
    });

    await initPromise;
    this.sendLsp({ jsonrpc: "2.0", method: "initialized", params: {} });
    this.lspReady = true;
    for (const r of this.lspReadyResolvers) r();
    this.lspReadyResolvers = [];
  }

  private waitForLspReady(): Promise<void> {
    if (this.lspReady) return Promise.resolve();
    return new Promise((resolve) => this.lspReadyResolvers.push(resolve));
  }

  // ─── File sync ──────────────────────────────────────────────────────────────

  /** Ensure the LSP has the file open, starting the backend if needed. Returns the file URI. */
  async ensureFile(absolutePath: string): Promise<string> {
    await this.ensureStarted();
    await this.waitForLspReady();
    const { uri, notification, isNewRoot, projectRoot } = this.docManager.ensure(absolutePath);

    if (isNewRoot) {
      this.addWorkspaceFolder(projectRoot);
    }

    if (notification) {
      this.sendLsp({ jsonrpc: "2.0", method: `textDocument/${notification.type}`, params: notification.params });
    }

    // LRU eviction: close stale documents and clear their diagnostic caches
    const evicted = this.docManager.evict(MAX_OPEN_DOCUMENTS);
    for (const evictedUri of evicted) {
      this.sendLsp({
        jsonrpc: "2.0", method: "textDocument/didClose",
        params: { textDocument: { uri: evictedUri } },
      });
      this.diagnostics.delete(evictedUri);
    }

    return uri;
  }

  /**
   * Close a single file in the LSP. Sends textDocument/didClose and clears its
   * diagnostic cache. Returns the URI if the file was open, null otherwise.
   */
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

  /** Ensure the backend is started and ready (without opening a specific file). */
  async ensureReady(): Promise<void> {
    await this.ensureStarted();
    await this.waitForLspReady();
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

  // ─── Diagnostics ────────────────────────────────────────────────────────────

  /** Wait for the first diagnostics publish for this URI (with timeout). */
  async waitForFirstDiagnostics(uri: string): Promise<void> {
    return this.diagnostics.waitForFirst(uri);
  }

  getDiagnostics(uri: string): DiagnosticItem[] {
    return this.diagnostics.get(uri);
  }

  // ─── LSP Transport ──────────────────────────────────────────────────────────

  lspRequest(method: string, params: unknown): Promise<LspMessage | null> {
    return new Promise((resolve) => {
      if (!this.lsp || !this.lspReady) { resolve(null); return; }
      const id = this.nextLspId++;
      const timer = setTimeout(() => {
        this.pendingLsp.delete(id);
        resolve(null);
      }, LSP_REQUEST_TIMEOUT_MS);

      this.pendingLsp.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: () => { clearTimeout(timer); resolve(null); },
      });

      this.sendLsp({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onLspMessage(msg: LspMessage): void {
    if (msg.method === "textDocument/publishDiagnostics") {
      this.onDiagnostics(msg.params as any);
      return;
    }
    if (msg.id != null) {
      const pending = this.pendingLsp.get(msg.id as number);
      if (pending) {
        this.pendingLsp.delete(msg.id as number);
        pending.resolve(msg);
      }
    }
  }

  private onDiagnostics(params: { uri: string; diagnostics: any[] }): void {
    const prefix = this.codePrefix;
    const items: DiagnosticItem[] = params.diagnostics.map((d) => {
      const pos = toOneBased(d.range.start.line, d.range.start.character);
      const rawCode = d.code != null ? String(d.code) : "";
      const code = rawCode && prefix && !rawCode.startsWith(prefix) ? `${prefix}${rawCode}` : rawCode;
      return {
        line: pos.line,
        character: pos.character,
        severity: severityLabel(d.severity),
        code,
        message: truncateMessage(d.message),
      };
    });
    this.diagnostics.publish(params.uri, items);
  }

  private sendLsp(msg: LspMessage): void {
    if (!this.lsp?.stdin) return;
    this.lsp.stdin.write(serializeMessage(msg));
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────────

  shutdown(): void {
    if (this.lsp) {
      try { this.sendLsp({ jsonrpc: "2.0", id: this.nextLspId++, method: "shutdown", params: null }); } catch {}
      try { this.lsp.kill(); } catch {}
      this.lsp = null;
    }
    this.started = false;
    this.lspReady = false;
  }
}
