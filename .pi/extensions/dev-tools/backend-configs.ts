/**
 * Backend configurations — single source of truth for all language server providers.
 *
 * Adding a new language:
 * 1. Add a BackendConfig entry to BACKEND_CONFIGS
 * 2. That's it — daemon constructs the backend, filetypes derives support
 */
import { STANDARD_CAPABILITIES } from "./backend";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BackendConfig {
  /** Display name, e.g. "typescript" or "bash" */
  name: string;
  /** Binary to find + spawn, e.g. "typescript-language-server" */
  binaryName: string;
  /** Args for the binary, e.g. ["--stdio"] */
  binaryArgs: string[];
  /** File extension → LSP languageId mapping */
  extensions: Map<string, string>;
  /** LSP initialize capabilities object */
  capabilities: object;
  /** Prefix for diagnostic codes, e.g. "TS" (code 2339 → "TS2339") */
  codePrefix: string;
  /** Filenames that indicate a project root (walked up from file). Empty = use dirname. */
  rootMarkers: string[];
  /** Whether this backend supports workspace/symbol queries */
  supportsWorkspaceSymbols: boolean;
}

// ─── Per-backend LSP capabilities ─────────────────────────────────────────────

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

// ─── Backend definitions ──────────────────────────────────────────────────────

export const BACKEND_CONFIGS: BackendConfig[] = [
  {
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
];

// ─── Derived sets (used by filetypes.ts for client-side gate) ─────────────────

/** All file extensions supported by any backend. */
export const ALL_SUPPORTED_EXTENSIONS = new Set(
  BACKEND_CONFIGS.flatMap(c => [...c.extensions.keys()]),
);
