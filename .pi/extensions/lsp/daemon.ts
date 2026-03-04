#!/usr/bin/env bun
/**
 * LSP Daemon — standalone process that manages typescript-language-server.
 *
 * Spawns as a detached child process on first tool use, then survives across
 * pi sessions. Listens on a Unix socket for JSON-over-newline requests.
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
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { serializeMessage, LspParser, LspIdGenerator, type LspMessage } from "./lsp-transport";
import { DocumentManager } from "./document-manager";
import { FileWatcher } from "./file-watcher";
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

// ─── LspDaemon class ─────────────────────────────────────────────────────────

export class LspDaemon {
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

  private docManager = new DocumentManager();
  private fileWatcher: FileWatcher;
  private server: Server | null = null;

  private lastActivity = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private socketPath = SOCKET_PATH,
    private pidPath = PID_PATH,
    private idleTimeoutMs = IDLE_TIMEOUT_MS,
  ) {
    this.fileWatcher = new FileWatcher((path) => { this.onFileChange(path).catch(() => {}); });
  }

  // ─── Startup ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Write PID file
    writeFileSync(this.pidPath, String(process.pid), "utf8");

    // Remove stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }

    // Spawn LSP
    await this.spawnLsp();

    // Start socket server
    await this.startServer();

    // Start idle timer
    this.resetIdleTimer();
  }

  private async spawnLsp(): Promise<void> {
    // Find typescript-language-server binary
    const tsserverBin = await findBinary("typescript-language-server");
    if (!tsserverBin) {
      throw new Error("typescript-language-server not found in PATH");
    }

    this.lsp = spawn(tsserverBin, ["--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parser = new LspParser((msg) => this.onLspMessage(msg));

    this.lsp.stdout!.on("data", (chunk: Buffer) => parser.push(chunk));
    this.lsp.stderr!.on("data", () => {}); // suppress stderr
    this.lsp.on("exit", () => {
      this.lspReady = false;
      this.lsp = null;
    });

    // Send initialize request
    const initId = this.idGen.get();
    const initPromise = new Promise<LspMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLsp.delete(initId);
        reject(new Error("LSP initialize timed out"));
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
        capabilities: {
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
        },
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
    switch (req.action) {
      case "diagnostics": return this.handleDiagnostics(req);
      case "hover":       return this.handleHover(req);
      case "definition":  return this.handleDefinition(req);
      case "references":  return this.handleReferences(req);
      case "symbols":     return this.handleSymbols(req);
      case "status":      return this.handleStatus(req);
      case "shutdown":    this.shutdown(); return okResponse(req.id, { action: "status", running: false, projects: [], openFiles: [], watchedFiles: 0, idleMs: 0 } as StatusResult);
      default:            return errorResponse(req.id, `Unknown action: ${(req as any).action}`);
    }
  }

  // ─── File sync ───────────────────────────────────────────────────────────────

  private async ensureFile(absolutePath: string): Promise<string> {
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

  private async onFileChange(absolutePath: string): Promise<void> {
    // Re-sync file on disk change
    const { notification } = this.docManager.ensure(absolutePath);
    if (notification) {
      this.sendLsp({ jsonrpc: "2.0", method: `textDocument/${notification.type}`, params: notification.params });
    }
    // Diagnostics will be pushed back via publishDiagnostics
  }

  // ─── LSP Actions ─────────────────────────────────────────────────────────────

  private async handleDiagnostics(req: DaemonRequest): Promise<DaemonResponse> {
    if (!req.path) return errorResponse(req.id, "path required for diagnostics");
    const uri = await this.ensureFile(req.path);

    // Wait for diagnostics to arrive if not cached yet (first open)
    if (!this.diagCache.has(uri)) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1500);
        const waiters = this.diagReady.get(uri) ?? [];
        waiters.push(() => { clearTimeout(timeout); resolve(); });
        this.diagReady.set(uri, waiters);
      });
    }

    const items = this.diagCache.get(uri) ?? [];
    const errors = items.filter((d) => d.severity === "error");
    const warns = items.filter((d) => d.severity === "warning");

    const result: DiagnosticsResult = {
      action: "diagnostics",
      path: req.path,
      errorCount: errors.length,
      warnCount: warns.length,
      items,
    };
    return okResponse(req.id, result);
  }

  private async handleHover(req: DaemonRequest): Promise<DaemonResponse> {
    if (!req.path || req.line == null || req.character == null) {
      return errorResponse(req.id, "path, line, and character required for hover");
    }

    const uri = await this.ensureFile(req.path);
    const pos = toZeroBased(req.line, req.character);

    const lspRes = await this.lspRequest("textDocument/hover", {
      textDocument: { uri },
      position: pos,
    });

    if (!lspRes || !lspRes.result) {
      return errorResponse(req.id, "No hover information at this position");
    }

    const hover = lspRes.result as any;
    const { signature, docs } = parseHoverContent(hover);

    const result: HoverResult = {
      action: "hover",
      path: req.path,
      line: req.line,
      character: req.character,
      signature,
      ...(docs ? { docs } : {}),
    };
    return okResponse(req.id, result);
  }

  private async handleDefinition(req: DaemonRequest): Promise<DaemonResponse> {
    if (!req.path || req.line == null || req.character == null) {
      return errorResponse(req.id, "path, line, and character required for definition");
    }

    const uri = await this.ensureFile(req.path);
    const pos = toZeroBased(req.line, req.character);
    const projectRoot = this.docManager.getProjectRoot(req.path);

    const lspRes = await this.lspRequest("textDocument/definition", {
      textDocument: { uri },
      position: pos,
    });

    if (!lspRes?.result) {
      return errorResponse(req.id, "No definition found");
    }

    const rawLocations = Array.isArray(lspRes.result) ? lspRes.result : [lspRes.result];
    const locations: DefinitionLocation[] = [];

    for (const loc of rawLocations.slice(0, 5)) {
      const defPath = uriToPath(loc.uri);
      const startLine = loc.range.start.line; // 0-indexed
      const endLine = loc.range.end.line;     // 0-indexed
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

    const uri = await this.ensureFile(req.path);
    const pos = toZeroBased(req.line, req.character);
    const projectRoot = this.docManager.getProjectRoot(req.path);

    const lspRes = await this.lspRequest("textDocument/references", {
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
      // Document symbols
      const uri = await this.ensureFile(req.path);
      const projectRoot = this.docManager.getProjectRoot(req.path);

      const lspRes = await this.lspRequest("textDocument/documentSymbol", {
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
      // Workspace symbols
      const lspRes = await this.lspRequest("workspace/symbol", { query: req.query });
      const raw = (lspRes?.result ?? []) as any[];

      const items: SymbolItem[] = raw.slice(0, MAX).map((s) => {
        const symPath = uriToPath(s.location.uri);
        const root = this.docManager.getProjectRoot(symPath);
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
    const openFiles = this.docManager.openUris.map(uriToPath);
    const result: StatusResult = {
      action: "status",
      running: this.lspReady,
      pid: process.pid,
      projects: this.docManager.projectRoots,
      openFiles,
      watchedFiles: openFiles.length,
      idleMs: Date.now() - this.lastActivity,
    };
    return okResponse(req.id, result);
  }

  // ─── LSP Transport ────────────────────────────────────────────────────────────

  private sendLsp(msg: LspMessage): void {
    if (!this.lsp?.stdin) return;
    this.lsp.stdin.write(serializeMessage(msg));
  }

  private lspRequest(method: string, params: unknown): Promise<LspMessage | null> {
    return new Promise((resolve) => {
      if (!this.lsp || !this.lspReady) { resolve(null); return; }

      const id = this.idGen.get();
      const timer = setTimeout(() => {
        this.pendingLsp.delete(id);
        resolve(null);
      }, 5000);

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
    const items: DiagnosticItem[] = params.diagnostics.map((d) => {
      const pos = toOneBased(d.range.start.line, d.range.start.character);
      return {
        line: pos.line,
        character: pos.character,
        severity: severityLabel(d.severity),
        code: d.code ? `TS${d.code}` : "",
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

  // ─── Idle / Shutdown ──────────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown(), this.idleTimeoutMs);
  }

  shutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.fileWatcher.close();
    this.server?.close();
    if (this.lsp) {
      try { this.sendLsp({ jsonrpc: "2.0", id: this.idGen.get(), method: "shutdown", params: null }); } catch {}
      try { this.lsp.kill(); } catch {}
    }
    try { unlinkSync(this.socketPath); } catch {}
    try { unlinkSync(this.pidPath); } catch {}
    process.exit(0);
  }
}


async function findBinary(name: string): Promise<string | null> {
  // Check local node_modules first (installed in extension dir)
  const ext = import.meta.dir;
  const local = resolve(ext, "node_modules", ".bin", name);
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

function flattenSymbols(symbols: any[], projectRoot: string): SymbolItem[] {
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
      result.push(...flattenSymbols(s.children, projectRoot));
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
