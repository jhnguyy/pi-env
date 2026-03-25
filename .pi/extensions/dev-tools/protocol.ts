/**
 * LSP Daemon Protocol — shared types between client and daemon.
 *
 * All positions are 1-indexed in the protocol (converted to 0-indexed
 * internally when communicating with the typescript-language-server).
 */

// ─── Socket / PID paths ───────────────────────────────────────────────────────

const UID = process.getuid?.() ?? 1000;
export const SOCKET_PATH = `/tmp/pi-lsp-${UID}.sock`;
export const PID_PATH = `/tmp/pi-lsp-${UID}.pid`;

// ─── Actions ────────────────────────────────────────────────────────────────

export type LspAction =
  | "diagnostics"
  | "hover"
  | "definition"
  | "references"
  | "symbols"
  | "status"
  | "shutdown";

// ─── Daemon Request/Response ─────────────────────────────────────────────────

export interface DaemonRequest {
  id: number;
  action: LspAction;
  /** Absolute path to the file. Required for most actions. */
  path?: string;
  /** Absolute paths for bulk diagnostics (action=diagnostics). When provided, 'path' is ignored. */
  paths?: string[];
  /** Line number (1-indexed). Required for hover, definition, references. */
  line?: number;
  /** Column number (1-indexed). Required for hover, definition, references. */
  character?: number;
  /** Search query for workspace symbols (action=symbols without path). */
  query?: string;
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  result?: LspResult;
  error?: string;
}

// ─── Result Types ────────────────────────────────────────────────────────────

export type LspResult =
  | DiagnosticsResult
  | HoverResult
  | DefinitionResult
  | ReferencesResult
  | SymbolsResult
  | StatusResult;

export interface DiagnosticItem {
  /** 1-indexed line */
  line: number;
  /** 1-indexed column */
  character: number;
  severity: "error" | "warning" | "info" | "hint";
  /** TypeScript error code, e.g. TS2339 */
  code: string;
  /** Truncated to first sentence */
  message: string;
}

export interface DiagnosticsResult {
  action: "diagnostics";
  path: string;
  errorCount: number;
  warnCount: number;
  items: DiagnosticItem[];
  /** Language server backend name, e.g. "typescript" or "bash" */
  language?: string;
  /** Per-file results when bulk paths[] was requested. Present only for bulk calls. */
  files?: DiagnosticsResult[];
  /** Per-file errors for paths that failed (e.g. not found). Present only when some paths errored. */
  fileErrors?: string[];
}

export interface HoverResult {
  action: "hover";
  path: string;
  line: number;
  character: number;
  /** Type signature, stripped of markdown fencing */
  signature: string;
  /** JSDoc comment, if present */
  docs?: string;
}

export interface DefinitionLocation {
  /** Relative path from project root */
  relativePath: string;
  /** Absolute path */
  absolutePath: string;
  /** 1-indexed line */
  line: number;
  /** The definition body (up to 30 lines) */
  body: string;
  /** Number of additional lines not shown */
  truncatedLines?: number;
}

export interface DefinitionResult {
  action: "definition";
  path: string;
  line: number;
  character: number;
  locations: DefinitionLocation[];
}

export interface ReferenceItem {
  /** Relative path from project root */
  relativePath: string;
  /** Absolute path */
  absolutePath: string;
  /** 1-indexed line */
  line: number;
  /** Trimmed line content */
  content: string;
}

export interface ReferencesResult {
  action: "references";
  path: string;
  line: number;
  character: number;
  total: number;
  items: ReferenceItem[];
  truncated: boolean;
}

export interface SymbolItem {
  /** 1-indexed line */
  line: number;
  /** Symbol name */
  name: string;
  /** Kind label, e.g. "interface", "function", "property", "class" */
  kind: string;
  /** Relative path from project root (only for workspace symbols) */
  relativePath?: string;
  /** Absolute path (only for workspace symbols) */
  absolutePath?: string;
  /** Type detail, e.g. "name: string" */
  detail?: string;
}

export interface SymbolsResult {
  action: "symbols";
  /** Path queried for document symbols, undefined for workspace query */
  path?: string;
  /** Workspace query string, undefined for document symbols */
  query?: string;
  total: number;
  items: SymbolItem[];
  truncated: boolean;
}

export interface StatusResult {
  action: "status";
  running: boolean;
  pid?: number;
  projects: string[];
  /** Absolute paths of files currently open in the LSP (didOpen'd). */
  openFiles: string[];
  /** Count of open files — derived from openFiles.length. */
  watchedFiles: number;
  idleMs: number;
}

// ─── Serialization helpers ────────────────────────────────────────────────────

/** Serialize a request to newline-delimited JSON. */
export function serializeRequest(req: DaemonRequest): string {
  return JSON.stringify(req) + "\n";
}

/** Serialize a response to newline-delimited JSON. */
export function serializeResponse(res: DaemonResponse): string {
  return JSON.stringify(res) + "\n";
}

/** Parse a newline-delimited JSON request. Throws on parse error. */
export function parseRequest(line: string): DaemonRequest {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("Empty request line");
  return JSON.parse(trimmed) as DaemonRequest;
}

/** Parse a newline-delimited JSON response. Throws on parse error. */
export function parseResponse(line: string): DaemonResponse {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("Empty response line");
  return JSON.parse(trimmed) as DaemonResponse;
}

/** Create an error response. */
export function errorResponse(id: number, message: string): DaemonResponse {
  return { id, ok: false, error: message };
}

/** Create a success response. */
export function okResponse(id: number, result: LspResult): DaemonResponse {
  return { id, ok: true, result };
}
