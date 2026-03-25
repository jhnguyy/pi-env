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
import { extname, resolve as resolvePath } from "node:path";

import { serializeMessage, LspParser, LspIdGenerator, type LspMessage } from "./lsp-transport";
import { DocumentManager, MAX_OPEN_DOCUMENTS } from "./document-manager";
import { pathToUri, toOneBased, severityLabel, truncateMessage } from "./utils";
import type { DiagnosticItem } from "./protocol";

// ─── Constants ────────────────────────────────────────────────────────────────

export const LSP_INIT_TIMEOUT_MS = 10_000;
export const LSP_REQUEST_TIMEOUT_MS = 5_000;
export const DIAG_WAIT_TIMEOUT_MS = 1_500;

// ─── LSP Capabilities ─────────────────────────────────────────────────────────

export const STANDARD_CAPABILITIES = {
  textDocument: {
    hover: { contentFormat: ["plaintext"] },
    definition: {},
    references: {},
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
  private idGen = new LspIdGenerator();

  // Pending LSP requests: id → { resolve, reject }
  private pendingLsp = new Map<number, { resolve: (msg: LspMessage) => void; reject: (err: Error) => void }>();

  // Diagnostics cache: uri → DiagnosticItem[]
  private diagCache = new Map<string, DiagnosticItem[]>();
  // Pending waiters for first diagnostics publish: uri → resolvers
  private diagReady = new Map<string, Array<() => void>>();

  readonly docManager = new DocumentManager();

  private started = false;
  private startPromise: Promise<void> | null = null;
  /** Cached unavailability reason — set when binary not found; prevents repeated PATH scans. */
  private unavailable: string | null = null;

  constructor(
    /** Display name, e.g. "typescript" or "bash" */
    readonly name: string,
    /** Binary to find + spawn, e.g. "typescript-language-server" */
    private binaryName: string,
    /** Args for the binary, e.g. ["--stdio"] or ["start"] */
    private binaryArgs: string[],
    /** File extensions this backend handles, e.g. new Set([".ts", ".tsx"]) */
    readonly extensions: Set<string>,
    /** LSP initialize capabilities object */
    private lspCapabilities: object,
    /** Prefix for diagnostic codes, e.g. "TS" for TypeScript (code 2339 → "TS2339") */
    private codePrefix: string,
  ) {}

  /** Returns true if this backend handles the given file path (by extension). */
  handles(filePath: string): boolean {
    return this.extensions.has(extname(filePath));
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
        `.${this.extensions.values().next().value?.slice(1) ?? this.name} language intelligence unavailable`;
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
    const initId = this.idGen.get();
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
      this.diagCache.delete(evictedUri);
    }

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
    if (this.diagCache.has(uri)) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, DIAG_WAIT_TIMEOUT_MS);
      const waiters = this.diagReady.get(uri) ?? [];
      waiters.push(() => { clearTimeout(timeout); resolve(); });
      this.diagReady.set(uri, waiters);
    });
  }

  getDiagnostics(uri: string): DiagnosticItem[] {
    return this.diagCache.get(uri) ?? [];
  }

  // ─── LSP Transport ──────────────────────────────────────────────────────────

  lspRequest(method: string, params: unknown): Promise<LspMessage | null> {
    return new Promise((resolve) => {
      if (!this.lsp || !this.lspReady) { resolve(null); return; }
      const id = this.idGen.get();
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
    this.diagCache.set(params.uri, items);
    const waiters = this.diagReady.get(params.uri);
    if (waiters) {
      this.diagReady.delete(params.uri);
      for (const w of waiters) w();
    }
  }

  private sendLsp(msg: LspMessage): void {
    if (!this.lsp?.stdin) return;
    this.lsp.stdin.write(serializeMessage(msg));
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────────

  shutdown(): void {
    if (this.lsp) {
      try { this.sendLsp({ jsonrpc: "2.0", id: this.idGen.get(), method: "shutdown", params: null }); } catch {}
      try { this.lsp.kill(); } catch {}
      this.lsp = null;
    }
    this.started = false;
    this.lspReady = false;
  }
}
