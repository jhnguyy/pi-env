/**
 * handlers.ts — LSP action handlers for the daemon.
 *
 * Each handler is a standalone async function that receives the request and
 * a HandlerDeps object (backend accessor + state refs). Kept separate from
 * LspDaemon so the socket server wiring doesn't obscure the LSP semantics.
 */

import {
  uriToPath, toZeroBased, relativePath, extractLines,
  getFileLine, expandToBlock, symbolKindLabel,
} from "./utils";
import { okResponse, errorResponse } from "./protocol";
import type {
  DaemonRequest, DaemonResponse,
  DiagnosticsResult, HoverResult,
  DefinitionLocation, DefinitionResult,
  ReferenceItem, ReferencesResult,
  SymbolItem, SymbolsResult, StatusResult,
} from "./protocol";
import type { LspBackend } from "./backend";

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface HandlerDeps {
  getBackend: (filePath: string) => LspBackend;
  tsBackend: LspBackend;
  backends: LspBackend[];
  lastActivity: number;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleDiagnostics(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  if (!req.path) return errorResponse(req.id, "path required for diagnostics");

  const backend = deps.getBackend(req.path);
  const uri = await backend.ensureFile(req.path);
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

export async function handleHover(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  if (!req.path || req.line == null || req.character == null) {
    return errorResponse(req.id, "path, line, and character required for hover");
  }

  const backend = deps.getBackend(req.path);
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

export async function handleDefinition(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  if (!req.path || req.line == null || req.character == null) {
    return errorResponse(req.id, "path, line, and character required for definition");
  }

  const backend = deps.getBackend(req.path);
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

export async function handleReferences(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  if (!req.path || req.line == null || req.character == null) {
    return errorResponse(req.id, "path, line, and character required for references");
  }

  const backend = deps.getBackend(req.path);
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

export async function handleSymbols(req: DaemonRequest, deps: HandlerDeps): Promise<DaemonResponse> {
  const MAX = 50;

  if (req.path) {
    const backend = deps.getBackend(req.path);
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
    await deps.tsBackend.ensureReady();
    const lspRes = await deps.tsBackend.lspRequest("workspace/symbol", { query: req.query });
    const raw = (lspRes?.result ?? []) as any[];

    const items: SymbolItem[] = raw.slice(0, MAX).map((s) => {
      const symPath = uriToPath(s.location.uri);
      const root = deps.tsBackend.docManager.getProjectRoot(symPath);
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

export function handleStatus(req: DaemonRequest, deps: HandlerDeps): DaemonResponse {
  const allOpenFiles = deps.backends.flatMap((b) => b.openUris.map(uriToPath));
  const allProjects = deps.backends.flatMap((b) => b.projectRoots);

  return okResponse(req.id, {
    action: "status",
    running: deps.backends.some((b) => b.isRunning),
    pid: process.pid,
    projects: allProjects,
    openFiles: allOpenFiles,
    watchedFiles: allOpenFiles.length,
    idleMs: Date.now() - deps.lastActivity,
  } as StatusResult);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

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
    if (s.children?.length) {
      result.push(...flattenSymbols(s.children, _projectRoot));
    }
  }
  return result;
}
