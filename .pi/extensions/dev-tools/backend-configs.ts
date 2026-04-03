/**
 * Backend configurations — single source of truth for all dev-tools backends.
 *
 * dev-tools is a file-extension engine: it tracks edited files and dispatches
 * each to the appropriate backend at agent_end based on file extension.
 * Backends are either LSP servers (diagnostics/intelligence) or formatters
 * (one-shot file reformatting).
 *
 * Adding a new backend:
 * 1. Add a BackendConfig entry to BACKEND_CONFIGS with the correct mode.
 * 2. That's it — isSupported(), getBackendConfig(), and the agent_end dispatch
 *    loop all derive from this array automatically.
 *
 * LSP backends are also consumed by the daemon (spawned as persistent
 * subprocesses). Format backends are invoked directly by the agent_end hook
 * and are never passed to the daemon.
 */
import { extname } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BackendConfigBase {
  /** Display name shown in status messages, e.g. "typescript" or "hcl". */
  name: string;
  /** Binary to locate via PATH (or local node_modules/.bin). */
  binaryName: string;
  /** File extension → language label mapping, e.g. ".ts" → "typescript". */
  extensions: Map<string, string>;
  /** Filenames walked up from the file to find the project root. Empty = use dirname. */
  rootMarkers: string[];
}

/** A persistent language server backend (diagnostics, hover, definition, …). */
export interface LspBackendConfig extends BackendConfigBase {
  mode: "lsp";
  /** Args passed to the language server binary, e.g. ["--stdio"]. */
  binaryArgs: string[];
  /** LSP initialize capabilities sent during handshake. */
  capabilities: object;
  /** Prefix prepended to numeric diagnostic codes, e.g. "TS" → "TS2339". */
  codePrefix: string;
  /** Whether this backend supports workspace/symbol queries. */
  supportsWorkspaceSymbols: boolean;
}

/** A one-shot file formatter (runs per-file at agent_end, no persistent process). */
export interface FormatBackendConfig extends BackendConfigBase {
  mode: "format";
  /**
   * Build the argument list for a formatting invocation.
   * Called once per file — the binary is `binaryName`.
   * @example (f) => ["hclfmt", "--terragrunt-hclfmt-file", f]
   */
  formatArgs: (filePath: string) => string[];
}

export type BackendConfig = LspBackendConfig | FormatBackendConfig;

// ─── Per-backend LSP capabilities ─────────────────────────────────────────────

/** Baseline LSP capabilities shared across most backends. */
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

const TS_CAPABILITIES = {
  ...STANDARD_CAPABILITIES,
  textDocument: {
    ...STANDARD_CAPABILITIES.textDocument,
    implementation: {},
    callHierarchy: { dynamicRegistration: false },
  },
};

const BASH_CAPABILITIES = {
  textDocument: {
    hover: { contentFormat: ["plaintext"] },
    definition: {},
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: false },
    publishDiagnostics: { relatedInformation: false },
  },
  workspace: {
    workspaceFolders: true,
  },
};

const NIX_CAPABILITIES = {
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

// ─── Backend registry ─────────────────────────────────────────────────────────

export const BACKEND_CONFIGS: BackendConfig[] = [
  // ── LSP backends ────────────────────────────────────────────────────────────
  {
    mode: "lsp",
    name: "typescript",
    binaryName: "typescript-language-server",
    binaryArgs: ["--stdio"],
    extensions: new Map([
      [".ts", "typescript"], [".tsx", "typescriptreact"],
      [".js", "javascript"], [".jsx", "javascriptreact"],
      [".mts", "typescript"], [".cts", "typescript"],
      [".mjs", "javascript"], [".cjs", "javascript"],
    ]),
    capabilities: TS_CAPABILITIES,
    codePrefix: "TS",
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", "bunfig.toml"],
    supportsWorkspaceSymbols: true,
  },
  {
    mode: "lsp",
    name: "bash",
    binaryName: "bash-language-server",
    binaryArgs: ["start"],
    extensions: new Map([
      [".sh", "shellscript"], [".bash", "shellscript"],
      [".zsh", "shellscript"], [".ksh", "shellscript"],
    ]),
    capabilities: BASH_CAPABILITIES,
    codePrefix: "",
    rootMarkers: [],
    supportsWorkspaceSymbols: false,
  },
  {
    mode: "lsp",
    name: "nil",
    binaryName: "nil",
    binaryArgs: [],
    extensions: new Map([
      [".nix", "nix"],
    ]),
    capabilities: NIX_CAPABILITIES,
    codePrefix: "",
    rootMarkers: ["flake.nix"],
    supportsWorkspaceSymbols: false,
  },

  // ── Format backends ─────────────────────────────────────────────────────────
  {
    mode: "format",
    name: "hcl",
    binaryName: "terragrunt",
    extensions: new Map([[".hcl", "hcl"]]),
    rootMarkers: ["terragrunt.hcl"],
    formatArgs: (f) => ["hclfmt", "--terragrunt-hclfmt-file", f],
  },
  {
    mode: "format",
    name: "terraform",
    binaryName: "terraform",
    extensions: new Map([[".tf", "terraform"], [".tfvars", "terraform"]]),
    rootMarkers: [],
    formatArgs: (f) => ["fmt", f],
  },
];

// ─── Derived lookups ──────────────────────────────────────────────────────────

/** All file extensions handled by any registered backend. */
export const SUPPORTED_EXTENSIONS = new Set(
  BACKEND_CONFIGS.flatMap((c) => [...c.extensions.keys()]),
);

/**
 * Returns true if any backend can process this file at agent_end.
 * Replaces the former `isLspSupported` — dev-tools covers both LSP and formatters.
 */
export function isSupported(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path));
}

/**
 * Return the BackendConfig responsible for the given file path, or null if
 * no backend matches. First match wins (registry order).
 */
export function getBackendConfig(path: string): BackendConfig | null {
  const ext = extname(path);
  return BACKEND_CONFIGS.find((c) => c.extensions.has(ext)) ?? null;
}
