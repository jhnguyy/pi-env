/** Keep LSP handlers separate from the socket lifecycle so tests can call the protocol behavior directly. */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  uriToPath, toZeroBased, relativePath, symbolKindLabel,
} from "./utils";
import type { FileCache } from "./file-cache";
import { okResponse, errorResponse } from "./protocol";
import type {
  DaemonRequest, DaemonResponse,
  DiagnosticsResult, HoverResult,
  DefinitionLocation, DefinitionResult, ImplementationResult,
  CallHierarchyItem, IncomingCallsResult, OutgoingCallsResult,
  ReferenceItem, ReferencesResult, RenameResult,
  SymbolItem, SymbolsResult, StatusResult,
} from "./protocol";
import type { LspBackend } from "./backend";
import { applyWorkspaceEdit } from "./workspace-edit";

export interface HandlerDeps {
  getBackend: (filePath: string) => LspBackend;
  getWorkspaceSymbolBackends: () => LspBackend[];
  backends: LspBackend[];
  fileCache: FileCache;
  /** Returns ms since last activity *before* the current request. */
  getIdleMs: () => number;
}

interface RequestContext {
  backend: LspBackend;
  uri: string;
  pos: { line: number; character: number };
  projectRoot: string;
}

async function prepareRequest(req: DaemonRequest, deps: HandlerDeps, action: string): Promise<RequestContext> {
  if (!req.path || req.line == null || req.character == null) {
    throw new Error(`path, line, and character required for ${action}`);
  }
  if (!isAbsolute(req.path)) throw new Error(`absolute path required for ${action}`);
  if (
    !Number.isInteger(req.line) ||
    req.line < 1 ||
    !Number.isInteger(req.character) ||
    req.character < 1
  ) {
    throw new Error(`positive integer line and character values required for ${action}`);
  }
  const backend = deps.getBackend(req.path);
  const uri = await backend.ensureFile(req.path);
  const pos = toZeroBased(req.line, req.character);
  const projectRoot = backend.getProjectRoot(req.path);
  return { backend, uri, pos, projectRoot };
}

const BULK_OPEN_CONCURRENCY = 4;

interface PendingDiagnostics {
  path: string;
  backend: LspBackend;
  uri: string;
}

async function prepareDiagnostics(path: string, deps: HandlerDeps): Promise<PendingDiagnostics> {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const backend = deps.getBackend(path);
  const uri = await backend.ensureFile(path);
  return { path, backend, uri };
}

async function finishDiagnostics(pending: PendingDiagnostics): Promise<DiagnosticsResult> {
  const { path, backend, uri } = pending;
  await backend.waitForDiagnostics(uri);
  const items = backend.getDiagnostics(uri);
  const errors = items.filter((d) => d.severity === "error");
  const warns = items.filter((d) => d.severity === "warning");
  return {
    action: "diagnostics",
    path,
    errorCount: errors.length,
    warnCount: warns.length,
    items,
    language: backend.name,
  };
}

async function diagForPath(path: string, deps: HandlerDeps): Promise<DiagnosticsResult> {
  return finishDiagnostics(await prepareDiagnostics(path, deps));
}

async function finishPreparedDiagnostics(
  prepared: PromiseSettledResult<PendingDiagnostics>,
): Promise<PromiseSettledResult<DiagnosticsResult>> {
  if (prepared.status === "rejected") return prepared;
  try {
    return { status: "fulfilled", value: await finishDiagnostics(prepared.value) };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = { status: "fulfilled", value: await fn(items[idx]) };
      } catch (e) {
        results[idx] = { status: "rejected", reason: e };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function handleDiagnostics(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  if (req.paths && req.paths.length > 0) {
    const unique = [...new Set(req.paths)];
    const prepared = await mapConcurrent(unique, BULK_OPEN_CONCURRENCY, (p) => prepareDiagnostics(p, deps));
    const settled = await Promise.all(prepared.map(finishPreparedDiagnostics));

    const files: DiagnosticsResult[] = [];
    const errors: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === "fulfilled") {
        files.push(r.value);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        errors.push(`${unique[i]}: ${msg}`);
      }
    }

    const totalErrors = files.reduce((s, f) => s + f.errorCount, 0);
    const totalWarns  = files.reduce((s, f) => s + f.warnCount,  0);

    return okResponse(req.id, {
      action: "diagnostics",
      path: "(bulk)",
      files,
      fileErrors: errors.length > 0 ? errors : undefined,
      errorCount: totalErrors,
      warnCount: totalWarns,
      items: [],
    } as DiagnosticsResult);
  }

  if (!req.path) return errorResponse(req.id, "path or paths required for diagnostics");
  return okResponse(req.id, await diagForPath(req.path, deps));
}

export async function handleHover(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  let ctx: RequestContext;
  try { ctx = await prepareRequest(req, deps, "hover"); }
  catch (e) { return errorResponse(req.id, (e as Error).message); }

  const lspRes = await ctx.backend.lspRequest("textDocument/hover", {
    textDocument: { uri: ctx.uri },
    position: ctx.pos,
  });

  if (!lspRes?.result) {
    ctx.backend.recordSemanticResult("textDocument/hover", 0);
    return errorResponse(req.id, "No hover information at this position");
  }

  const { signature, docs } = parseHoverContent(lspRes.result as any);
  ctx.backend.recordSemanticResult("textDocument/hover", signature ? 1 : 0);
  return okResponse(req.id, {
    action: "hover",
    path: req.path,
    line: req.line,
    character: req.character,
    signature,
    ...(docs ? { docs } : {}),
  } as HoverResult);
}

async function handleLocationAction(
  req: DaemonRequest,
  deps: HandlerDeps,
  action: "definition" | "implementation",
  lspMethod: string,
  emptyMsg: string,
): Promise<DaemonResponse> {
  let ctx: RequestContext;
  try { ctx = await prepareRequest(req, deps, action); }
  catch (e) { return errorResponse(req.id, (e as Error).message); }

  const lspRes = await ctx.backend.lspRequest(lspMethod, {
    textDocument: { uri: ctx.uri },
    position: ctx.pos,
  });

  if (!lspRes?.result) {
    ctx.backend.recordSemanticResult(lspMethod, 0);
    return errorResponse(req.id, emptyMsg);
  }

  const rawLocations = Array.isArray(lspRes.result) ? lspRes.result : [lspRes.result];
  const locations: DefinitionLocation[] = [];

  for (const loc of rawLocations.slice(0, 5)) {
    const defPath = uriToPath(loc.uri);
    const startLine = loc.range.start.line;
    const endLine = loc.range.end.line;
    const expandedEnd = await deps.fileCache.expandToBlock(defPath, startLine, endLine, 30);
    const body = await deps.fileCache.extractLines(defPath, startLine, expandedEnd) ?? "";
    const bodyLines = body.split("\n");
    const truncated = bodyLines.length > 30 ? bodyLines.length - 30 : 0;

    locations.push({
      relativePath: relativePath(ctx.projectRoot, defPath),
      absolutePath: defPath,
      line: startLine + 1,
      body: bodyLines.slice(0, 30).join("\n"),
      ...(truncated > 0 ? { truncatedLines: truncated } : {}),
    });
  }

  ctx.backend.recordSemanticResult(lspMethod, locations.length);
  if (locations.length === 0) return errorResponse(req.id, emptyMsg);

  return okResponse(req.id, {
    action,
    path: req.path,
    line: req.line,
    character: req.character,
    locations,
  } as DefinitionResult | ImplementationResult);
}

export async function handleDefinition(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  return handleLocationAction(req, deps, "definition", "textDocument/definition", "No definition found");
}

export async function handleImplementation(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  return handleLocationAction(req, deps, "implementation", "textDocument/implementation", "No implementations found");
}

async function handleCallHierarchy(
  req: DaemonRequest,
  deps: HandlerDeps,
  action: "incoming-calls" | "outgoing-calls",
  lspMethod: string,
  peerField: "from" | "to",
): Promise<DaemonResponse> {
  let ctx: RequestContext;
  try { ctx = await prepareRequest(req, deps, action); }
  catch (e) { return errorResponse(req.id, (e as Error).message); }

  const prepareRes = await ctx.backend.lspRequest("textDocument/prepareCallHierarchy", {
    textDocument: { uri: ctx.uri },
    position: ctx.pos,
  });

  if (!prepareRes?.result || !Array.isArray(prepareRes.result) || prepareRes.result.length === 0) {
    return errorResponse(req.id, "No call hierarchy item at this position");
  }

  const item = prepareRes.result[0];
  const symbolName = item.name ?? "unknown";

  const callsRes = await ctx.backend.lspRequest(lspMethod, { item });

  const emptyResult = {
    action, path: req.path, line: req.line, character: req.character,
    symbol: symbolName, total: 0, items: [], truncated: false,
  } as IncomingCallsResult | OutgoingCallsResult;

  if (!callsRes?.result || !Array.isArray(callsRes.result)) {
    ctx.backend.recordSemanticResult(lspMethod, 0);
    return okResponse(req.id, emptyResult);
  }

  const MAX = 30;
  const all = callsRes.result as Array<Record<string, any>>;
  const items: CallHierarchyItem[] = await Promise.all(
    all.slice(0, MAX).map(async (call) => {
      const peer = call[peerField];
      const peerPath = uriToPath(peer.uri);
      const peerLine = peer.selectionRange?.start?.line ?? peer.range?.start?.line ?? 0;
      return {
        name: peer.name,
        kind: symbolKindLabel(peer.kind),
        relativePath: relativePath(ctx.projectRoot, peerPath),
        absolutePath: peerPath,
        line: peerLine + 1,
        content: await deps.fileCache.getLine(peerPath, peerLine + 1),
      };
    }),
  );

  ctx.backend.recordSemanticResult(lspMethod, all.length);
  return okResponse(req.id, {
    action, path: req.path, line: req.line, character: req.character,
    symbol: symbolName, total: all.length, items, truncated: all.length > MAX,
  } as IncomingCallsResult | OutgoingCallsResult);
}

export async function handleIncomingCalls(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  return handleCallHierarchy(req, deps, "incoming-calls", "callHierarchy/incomingCalls", "from");
}

export async function handleOutgoingCalls(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  return handleCallHierarchy(req, deps, "outgoing-calls", "callHierarchy/outgoingCalls", "to");
}

export async function handleReferences(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  let ctx: RequestContext;
  try { ctx = await prepareRequest(req, deps, "references"); }
  catch (e) { return errorResponse(req.id, (e as Error).message); }

  const lspRes = await ctx.backend.lspRequest("textDocument/references", {
    textDocument: { uri: ctx.uri },
    position: ctx.pos,
    context: { includeDeclaration: true },
  });

  if (!lspRes?.result) {
    ctx.backend.recordSemanticResult("textDocument/references", 0);
    return okResponse(req.id, {
      action: "references", path: req.path, line: req.line, character: req.character,
      total: 0, items: [], truncated: false,
    } as ReferencesResult);
  }

  const all = lspRes.result as Array<{ uri: string; range: any }>;
  const MAX = 20;
  const items: ReferenceItem[] = await Promise.all(
    all.slice(0, MAX).map(async (ref) => {
      const refPath = uriToPath(ref.uri);
      return {
        relativePath: relativePath(ctx.projectRoot, refPath),
        absolutePath: refPath,
        line: ref.range.start.line + 1,
        content: await deps.fileCache.getLine(refPath, ref.range.start.line + 1),
      };
    }),
  );

  ctx.backend.recordSemanticResult("textDocument/references", all.length);
  return okResponse(req.id, {
    action: "references", path: req.path, line: req.line, character: req.character,
    total: all.length, items, truncated: all.length > MAX,
  } as ReferencesResult);
}

export async function handleRename(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  if (!req.newName?.trim()) return errorResponse(req.id, "newName required for rename");
  let ctx: RequestContext;
  try {
    ctx = await prepareRequest(req, deps, "rename");
  } catch (e) {
    return errorResponse(req.id, (e as Error).message);
  }

  const lspRes = await ctx.backend.lspRequest("textDocument/rename", {
    textDocument: { uri: ctx.uri },
    position: ctx.pos,
    newName: req.newName,
  });
  if (!lspRes?.result) return errorResponse(req.id, "No rename edits returned at this position");

  try {
    const allowedRoots = [...new Set([ctx.projectRoot, ...ctx.backend.projectRoots])];
    const authorizedBackends = new Map<string, LspBackend>();
    const applied = await applyWorkspaceEdit(lspRes.result, {
      allowedRoots,
      authorizeTarget: (requestedPath, realPath) => {
        const requestedBackend = deps.getBackend(requestedPath);
        const realBackend = deps.getBackend(realPath);
        if (requestedBackend !== realBackend) {
          throw new Error(`${requestedPath} resolves to a different backend owner.`);
        }
        authorizedBackends.set(requestedPath, requestedBackend);
        return {
          getDocumentSnapshot: (absolutePath) =>
            requestedBackend.getDocumentSnapshot(absolutePath),
        };
      },
    });
    for (const file of applied.files) deps.fileCache.invalidate(file.absolutePath);
    await Promise.all(
      applied.files.map((file) => authorizedBackends.get(file.absolutePath)!.ensureFile(file.absolutePath)),
    );
    ctx.backend.recordSemanticResult("textDocument/rename", applied.totalEdits);
    return okResponse(req.id, {
      action: "rename",
      path: req.path,
      line: req.line,
      character: req.character,
      newName: req.newName,
      totalEdits: applied.totalEdits,
      files: applied.files.map((file) => ({
        relativePath: relativePath(ctx.projectRoot, file.absolutePath),
        absolutePath: file.absolutePath,
        editCount: file.editCount,
      })),
    } as RenameResult);
  } catch (e) {
    return errorResponse(req.id, e instanceof Error ? e.message : String(e));
  }
}

export async function handleSymbols(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  const MAX = 50;

  if (req.path) {
    const backend = deps.getBackend(req.path);
    const uri = await backend.ensureFile(req.path);
    const projectRoot = backend.getProjectRoot(req.path);

    const lspRes = await backend.lspRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    const raw = (lspRes?.result ?? []) as any[];
    const items: SymbolItem[] = flattenSymbols(raw).slice(0, MAX);
    backend.recordSemanticResult("textDocument/documentSymbol", raw.length);

    return okResponse(req.id, {
      action: "symbols", path: req.path,
      total: items.length, items, truncated: raw.length > MAX,
    } as SymbolsResult);
  }

  if (req.query) {
    const supportedBackends = deps.getWorkspaceSymbolBackends();
    if (supportedBackends.length === 0) {
      return errorResponse(req.id, "No backends support workspace/symbol");
    }
    const wsBackends = supportedBackends.filter((backend) => backend.projectRoots.length > 0);
    if (wsBackends.length === 0) {
      return errorResponse(
        req.id,
        "Workspace symbols require an opened project file. Request document symbols first.",
      );
    }

    const allRaw: any[] = [];
    for (const b of wsBackends) {
      await b.ensureReady();
      const lspRes = await b.lspRequest("workspace/symbol", { query: req.query });
      const raw = (lspRes?.result ?? []) as any[];
      b.recordSemanticResult("workspace/symbol", raw.length);
      allRaw.push(...raw);
    }

    const items: SymbolItem[] = allRaw.slice(0, MAX).map((s) => {
      const symPath = uriToPath(s.location.uri);
      const owningBackend = deps.backends.find((b) => b.handles(symPath)) ?? wsBackends[0];
      const root = owningBackend.getProjectRoot(symPath);
      return {
        line: s.location.range.start.line + 1,
        name: s.name,
        kind: symbolKindLabel(s.kind),
        relativePath: relativePath(root, symPath),
        absolutePath: symPath,
      };
    });

    return okResponse(req.id, {
      action: "symbols", query: req.query,
      total: allRaw.length, items, truncated: allRaw.length > MAX,
    } as SymbolsResult);
  }

  return errorResponse(req.id, "symbols requires either path or query");
}

function deriveHealthState(snapshot: ReturnType<LspBackend["getStatusSnapshot"]> | undefined): StatusResult["state"] {
  if (!snapshot) return "failed";
  if (snapshot.initializationState === "failed") return "failed";
  if (!snapshot.running || snapshot.initializationState !== "initialized") return "initializing";
  if (snapshot.semanticAvailable) return "ready";
  return snapshot.semanticFailure ? "degraded" : "initializing";
}

export function handleStatus(req: DaemonRequest, deps: HandlerDeps): DaemonResponse {
  const allOpenFiles = deps.backends.flatMap((b) => b.openUris.map(uriToPath));
  const allProjects = deps.backends.flatMap((b) => b.projectRoots);
  const primary = deps.backends.find((b) => b.name === "typescript") ?? deps.backends[0];
  const snapshot = primary?.getStatusSnapshot();
  const state = deriveHealthState(snapshot);

  return okResponse(req.id, {
    action: "status",
    state,
    running: true,
    pid: process.pid,
    backend: snapshot ? {
      name: snapshot.name,
      running: snapshot.running,
      ...(snapshot.stderrTail ? { stderrTail: snapshot.stderrTail } : {}),
      ...(snapshot.startupFailure ? { startupFailure: snapshot.startupFailure } : {}),
    } : { name: "unknown", running: false },
    project: snapshot ? {
      mode: snapshot.projectMode,
      ...(snapshot.projectRoot ? { root: snapshot.projectRoot } : {}),
      ...(snapshot.tsconfigPath ? { tsconfigPath: snapshot.tsconfigPath } : {}),
    } : { mode: "unknown" },
    initialization: { state: snapshot?.initializationState ?? "failed" },
    semantic: {
      available: snapshot?.semanticAvailable ?? false,
      ...(snapshot?.lastSemanticRequest ? { lastRequest: snapshot.lastSemanticRequest } : {}),
      ...(snapshot?.semanticFailure ? { semanticFailure: snapshot.semanticFailure } : {}),
    },
    projects: allProjects,
    openFiles: allOpenFiles,
    watchedFiles: allOpenFiles.length,
    idleMs: deps.getIdleMs(),
  } as StatusResult);
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

  raw = raw.replace(/^```[a-z]*\n?/gm, "").replace(/^```\n?/gm, "").trim();

  const blankIdx = raw.indexOf("\n\n");
  if (blankIdx > 0) {
    return { signature: raw.slice(0, blankIdx).trim(), docs: raw.slice(blankIdx + 2).trim() || undefined };
  }

  return { signature: raw };
}

function flattenSymbols(symbols: any[]): SymbolItem[] {
  const result: SymbolItem[] = [];
  for (const s of symbols) {
    const line = (s.selectionRange ?? s.range)?.start?.line ?? 0;
    result.push({
      line: line + 1,
      name: s.name,
      kind: symbolKindLabel(s.kind),
      ...(s.detail ? { detail: s.detail } : {}),
    });
    if (s.children?.length) {
      result.push(...flattenSymbols(s.children));
    }
  }
  return result;
}
