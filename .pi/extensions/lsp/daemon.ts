#!/usr/bin/env bun
/**
 * LSP Daemon — standalone process that manages language servers.
 *
 * Manages multiple language server backends (TypeScript, Bash) via a shared
 * Unix socket. Backends start lazily on first file request and are routed
 * by file extension.
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
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
import { serializeMessage, LspParser, LspIdGenerator, type LspMessage } from "./lsp-transport";
import { DocumentManager } from "./document-manager";
import { FileWatcher } from "./file-watcher";
import { TS_EXTENSIONS, BASH_EXTENSIONS, NIX_EXTENSIONS } from "./filetypes";
import { pathToUri, uriToPath, toZeroBased, toOneBased, relativePath, extractLines, getFileLine, expandToBlock, symbolKindLabel, severityLabel, truncateMessage } from "./utils";
import {
  parseRequest, serializeResponse, errorResponse, okResponse,
  SOCKET_PATH, PID_PATH,
  type DaemonRequest, type DaemonResponse, type LspResult,
  type DiagnosticItem, type DiagnosticsResult, type HoverResult,
  type DefinitionLocation, type DefinitionResult, type ReferenceItem,
  type ReferencesResult, type SymbolItem, type SymbolsResult, type StatusResult,
} from "./protocol";

// ─── Constants ────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const LSP_INIT_TIMEOUT_MS = 10_000;
const LSP_REQUEST_TIMEOUT_MS = 5_000;
const DIAG_WAIT_TIMEOUT_MS = 1_500;

// ─── LSP Capabilities ─────────────────────────────────────────────────────────

const STANDARD_CAPABILITIES = {
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

// ─── LspBackend ───────────────────────────────────────────────────────────────

/**
 * Manages a single language server subprocess.
 * Backends start lazily on first file request.
 */
class LspBackend {
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
  readonly fileWatcher: FileWatcher;

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
  ) {
    this.fileWatcher = new FileWatcher((path) => { this.handleFileChange(path).catch(() => {}); });
  }

  /** Returns true if this backend handles the given file path (by extension). */
  handles(filePath: string): boolean {
    return this.extensions.has(extname(filePath));
  }

  get isRunning(): boolean { return this.lspReady; }
  get openUris(): string[] { return this.docManager.openUris; }
  get projectRoots(): string[] { return this.docManager.projectRoots; }

  // ─── Startup ──────────────────────────────────────────────────────────────

  async ensureStarted(): Promise<void> {
    if (this.started) return;
    // Fail fast — binary was already found to be missing; no point re-scanning PATH.
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
      // Warn once so the operator knows; don't crash the daemon.
      console.warn(`[lsp-daemon] WARNING: ${this.unavailable}`);
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

  // ─── File sync ────────────────────────────────────────────────────────────

  /** Ensure the LSP has the file open, starting the backend if needed. Returns the file URI. */
  async ensureFile(absolutePath: string): Promise<string> {
    await this.ensureStarted();
    await this.waitForLspReady();
    const { uri, notification, isNewRoot, projectRoot } = this.docManager.ensure(absolutePath);

    if (isNewRoot) {
      this.addWorkspaceFolder(projectRoot);
      this.fileWatcher.watch(projectRoot);
    }

    if (notification) {
      this.sendLsp({ jsonrpc: "2.0", method: `textDocument/${notification.type}`, params: notification.params });
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

  private async handleFileChange(absolutePath: string): Promise<void> {
    if (!this.started) return;
    const { notification } = this.docManager.ensure(absolutePath);
    if (notification) {
      this.sendLsp({ jsonrpc: "2.0", method: `textDocument/${notification.type}`, params: notification.params });
    }
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

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

  // ─── LSP Transport ────────────────────────────────────────────────────────

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
    // Diagnostics notification
    if (msg.method === "textDocument/publishDiagnostics") {
      this.onDiagnostics(msg.params as any);
      return;
    }

    // Response to a pending request
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
      // Avoid double-prefixing if the code already starts with the prefix
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

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  shutdown(): void {
    this.fileWatcher.close();
    if (this.lsp) {
      try { this.sendLsp({ jsonrpc: "2.0", id: this.idGen.get(), method: "shutdown", params: null }); } catch {}
      try { this.lsp.kill(); } catch {}
      this.lsp = null;
    }
    this.started = false;
    this.lspReady = false;
  }
}

// ─── LspDaemon ────────────────────────────────────────────────────────────────

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
      "typescript",
      "typescript-language-server",
      ["--stdio"],
      TS_EXTENSIONS,
      STANDARD_CAPABILITIES,
      "TS",
    );

    const bashBackend = new LspBackend(
      "bash",
      "bash-language-server",
      ["start"],
      BASH_EXTENSIONS,
      STANDARD_CAPABILITIES,
      "",  // shellcheck codes are already prefixed (SC2034) or numeric
    );

    const nilBackend = new LspBackend(
      "nil",
      "nil",
      [],   // nil uses stdio with no args (unlike typescript-language-server --stdio)
      NIX_EXTENSIONS,
      STANDARD_CAPABILITIES,
      "",   // nil diagnostic codes have no standard prefix
    );

    this.backends = [this.tsBackend, bashBackend, nilBackend];
  }

  /** Return the backend that handles this file, falling back to TypeScript. */
  private getBackend(filePath: string): LspBackend {
    return this.backends.find((b) => b.handles(filePath)) ?? this.tsBackend;
  }

  // ─── Startup ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Write PID file
    writeFileSync(this.pidPath, String(process.pid), "utf8");

    // Remove stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }

    // Start socket server (backends start lazily on first request)
    await this.startServer();

    // Start idle timer
    this.resetIdleTimer();
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  // ─── Connection handling ──────────────────────────────────────────────────

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
    switch (req.action) {
      case "diagnostics": return this.handleDiagnostics(req);
      case "hover":       return this.handleHover(req);
      case "definition":  return this.handleDefinition(req);
      case "references":  return this.handleReferences(req);
      case "symbols":     return this.handleSymbols(req);
      case "status":      return this.handleStatus(req);
      case "shutdown":
        this.shutdown();
        return okResponse(req.id, {
          action: "status", running: false, projects: [], openFiles: [], watchedFiles: 0, idleMs: 0,
        } as StatusResult);
      default:
        return errorResponse(req.id, `Unknown action: ${(req as any).action}`);
    }
  }

  // ─── LSP Actions ──────────────────────────────────────────────────────────

  private async handleDiagnostics(req: DaemonRequest): Promise<DaemonResponse> {
    if (!req.path) return errorResponse(req.id, "path required for diagnostics");

    const backend = this.getBackend(req.path);
    const uri = await backend.ensureFile(req.path);

    // Wait for diagnostics to arrive if not cached yet (first open)
    await backend.waitForFirstDiagnostics(uri);

    const items = backend.getDiagnostics(uri);
    const errors = items.filter((d) => d.severity === "error");
    const warns = items.filter((d) => d.severity === "warning");

    return okResponse(req.id, {
      action: "diagnostics",
      path: req.path,
      errorCount: errors.length,
      warnCount: warns.length,
      items,
      language: backend.name,
    } as DiagnosticsResult);
  }

  private async handleHover(req: DaemonRequest): Promise<DaemonResponse> {
    if (!req.path || req.line == null || req.character == null) {
      return errorResponse(req.id, "path, line, and character required for hover");
    }

    const backend = this.getBackend(req.path);
    const uri = await backend.ensureFile(req.path);
    const pos = toZeroBased(req.line, req.character);

    const lspRes = await backend.lspRequest("textDocument/hover", {
      textDocument: { uri },
      position: pos,
    });

    if (!lspRes?.result) {
      return errorResponse(req.id, "No hover information at this position");
    }

    const { signature, docs } = parseHoverContent(lspRes.result as any);
    return okResponse(req.id, {
      action: "hover",
      path: req.path,
      line: req.line,
      character: req.character,
      signature,
      ...(docs ? { docs } : {}),
    } as HoverResult);
  }

  private async handleDefinition(req: DaemonRequest): Promise<DaemonResponse> {
    if (!req.path || req.line == null || req.character == null) {
      return errorResponse(req.id, "path, line, and character required for definition");
    }

    const backend = this.getBackend(req.path);
    const uri = await backend.ensureFile(req.path);
    const pos = toZeroBased(req.line, req.character);
    const projectRoot = backend.docManager.getProjectRoot(req.path);

    const lspRes = await backend.lspRequest("textDocument/definition", {
      textDocument: { uri },
      position: pos,
    });

    if (!lspRes?.result) return errorResponse(req.id, "No definition found");

    const rawLocations = Array.isArray(lspRes.result) ? lspRes.result : [lspRes.result];
    const locations: DefinitionLocation[] = [];

    for (const loc of rawLocations.slice(0, 5)) {
      const defPath = uriToPath(loc.uri);
      const startLine = loc.range.start.line;
      const endLine = loc.range.end.line;
      const expandedEnd = expandToBlock(defPath, startLine, endLine, 30);
      const body = extractLines(defPath, startLine, expandedEnd) ?? "";
      const bodyLines = body.split("\n");
      const truncated = bodyLines.length > 30 ? bodyLines.length - 30 : 0;

      locations.push({
        relativePath: relativePath(projectRoot, defPath),
        absolutePath: defPath,
        line: startLine + 1,
        body: bodyLines.slice(0, 30).join("\n"),
        ...(truncated > 0 ? { truncatedLines: truncated } : {}),
      });
    }

    if (locations.length === 0) return errorResponse(req.id, "No definition found");

    return okResponse(req.id, {
      action: "definition",
      path: req.path,
      line: req.line,
      character: req.character,
      locations,
    } as DefinitionResult);
  }

  private async handleReferences(req: DaemonRequest): Promise<DaemonResponse> {
    if (!req.path || req.line == null || req.character == null) {
      return errorResponse(req.id, "path, line, and character required for references");
    }

    const backend = this.getBackend(req.path);
    const uri = await backend.ensureFile(req.path);
    const pos = toZeroBased(req.line, req.character);
    const projectRoot = backend.docManager.getProjectRoot(req.path);

    const lspRes = await backend.lspRequest("textDocument/references", {
      textDocument: { uri },
      position: pos,
      context: { includeDeclaration: true },
    });

    if (!lspRes?.result) {
      return okResponse(req.id, {
        action: "references", path: req.path, line: req.line, character: req.character,
        total: 0, items: [], truncated: false,
      } as ReferencesResult);
    }

    const all = lspRes.result as Array<{ uri: string; range: any }>;
    const MAX = 20;
    const items: ReferenceItem[] = all.slice(0, MAX).map((ref) => {
      const refPath = uriToPath(ref.uri);
      return {
        relativePath: relativePath(projectRoot, refPath),
        absolutePath: refPath,
        line: ref.range.start.line + 1,
        content: getFileLine(refPath, ref.range.start.line + 1),
      };
    });

    return okResponse(req.id, {
      action: "references",
      path: req.path,
      line: req.line,
      character: req.character,
      total: all.length,
      items,
      truncated: all.length > MAX,
    } as ReferencesResult);
  }

  private async handleSymbols(req: DaemonRequest): Promise<DaemonResponse> {
    const MAX = 50;

    if (req.path) {
      // Document symbols — route to the appropriate backend
      const backend = this.getBackend(req.path);
      const uri = await backend.ensureFile(req.path);
      const projectRoot = backend.docManager.getProjectRoot(req.path);

      const lspRes = await backend.lspRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      });

      const raw = (lspRes?.result ?? []) as any[];
      const items: SymbolItem[] = flattenSymbols(raw, projectRoot).slice(0, MAX);

      return okResponse(req.id, {
        action: "symbols",
        path: req.path,
        total: items.length,
        items,
        truncated: raw.length > MAX,
      } as SymbolsResult);
    }

    if (req.query) {
      // Workspace symbols — TypeScript backend only
      await this.tsBackend.ensureReady();
      const lspRes = await this.tsBackend.lspRequest("workspace/symbol", { query: req.query });
      const raw = (lspRes?.result ?? []) as any[];

      const items: SymbolItem[] = raw.slice(0, MAX).map((s) => {
        const symPath = uriToPath(s.location.uri);
        const root = this.tsBackend.docManager.getProjectRoot(symPath);
        return {
          line: s.location.range.start.line + 1,
          name: s.name,
          kind: symbolKindLabel(s.kind),
          relativePath: relativePath(root, symPath),
          absolutePath: symPath,
        };
      });

      return okResponse(req.id, {
        action: "symbols",
        query: req.query,
        total: raw.length,
        items,
        truncated: raw.length > MAX,
      } as SymbolsResult);
    }

    return errorResponse(req.id, "symbols requires either path or query");
  }

  private async handleStatus(req: DaemonRequest): Promise<DaemonResponse> {
    const allOpenFiles = this.backends.flatMap((b) => b.openUris.map(uriToPath));
    const allProjects = this.backends.flatMap((b) => b.projectRoots);

    const result: StatusResult = {
      action: "status",
      running: this.backends.some((b) => b.isRunning),
      pid: process.pid,
      projects: allProjects,
      openFiles: allOpenFiles,
      watchedFiles: allOpenFiles.length,
      idleMs: Date.now() - this.lastActivity,
    };
    return okResponse(req.id, result);
  }

  // ─── Idle / Shutdown ──────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findBinary(name: string): Promise<string | null> {
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

function parseHoverContent(hover: any): { signature: string; docs?: string } {
  const contents = hover.contents;
  let raw = "";

  if (typeof contents === "string") {
    raw = contents;
  } else if (Array.isArray(contents)) {
    raw = contents.map((c: any) => (typeof c === "string" ? c : c.value ?? "")).join("\n");
  } else if (contents && typeof contents === "object") {
    raw = contents.value ?? "";
  }

  // Strip markdown code fences
  raw = raw.replace(/^```[a-z]*\n?/gm, "").replace(/^```\n?/gm, "").trim();

  // Split into signature and docs at first blank line
  const blankIdx = raw.indexOf("\n\n");
  if (blankIdx > 0) {
    return { signature: raw.slice(0, blankIdx).trim(), docs: raw.slice(blankIdx + 2).trim() || undefined };
  }

  return { signature: raw };
}

function flattenSymbols(symbols: any[], _projectRoot: string): SymbolItem[] {
  const result: SymbolItem[] = [];
  for (const s of symbols) {
    const line = (s.selectionRange ?? s.range)?.start?.line ?? 0;
    result.push({
      line: line + 1,
      name: s.name,
      kind: symbolKindLabel(s.kind),
      ...(s.detail ? { detail: s.detail } : {}),
    });
    // Flatten children if present (hierarchical response)
    if (s.children?.length) {
      result.push(...flattenSymbols(s.children, _projectRoot));
    }
  }
  return result;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Only run as daemon when executed directly (not when imported in tests)
if (import.meta.main) {
  const daemon = new LspDaemon();
  process.on("SIGTERM", () => daemon.shutdown());
  process.on("SIGINT", () => daemon.shutdown());
  daemon.start().catch((err) => {
    console.error("Daemon failed to start:", err);
    process.exit(1);
  });
}
