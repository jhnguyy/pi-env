/**
 * Language-server configurations used by the dev-tools daemon.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  ProcessEnvironmentName,
  resolveNodeCommand,
} from "../../../src/process/platform.js";

// ─── Types ────────────────────────────────────────────────────────────────────

const BackendName = {
  TypeScript: "typescript",
  Bash: "bash",
  Nil: "nil",
} as const;
type BackendName = typeof BackendName[keyof typeof BackendName];

interface BackendConfigBase {
  /** Display name shown in status messages, e.g. "typescript" or "bash". */
  name: BackendName;
  /** Binary to locate via PATH (or local node_modules/.bin). */
  binaryName: string;
  /** File extension → language label mapping, e.g. ".ts" → "typescript". */
  extensions: Map<string, string>;
  /** Filenames walked up from the file to find the project root. Empty = use dirname. */
  rootMarkers: string[];
}

/** A persistent language server backend (diagnostics, hover, definition, …). */
export interface LspBackendConfig extends BackendConfigBase {
  /** Args passed to the language server binary, e.g. ["--stdio"]. */
  binaryArgs: string[];
  /** Command and args used to spawn the backend. Node-module servers use Node plus their JS entrypoint. */
  launchCommand: string;
  launchArgs: string[];
  nodeExecPathShim?: string;
  /** LSP initialize capabilities sent during handshake. */
  capabilities: object;
  /** Server-specific options sent during the initialize handshake. */
  initializationOptions?: object;
  /** Prefix prepended to numeric diagnostic codes, e.g. "TS" → "TS2339". */
  codePrefix: string;
  /** Whether this backend supports workspace/symbol queries. */
  supportsWorkspaceSymbols: boolean;
}

// ─── Per-backend LSP capabilities ─────────────────────────────────────────────

/** Baseline LSP capabilities shared across most backends. */
const STANDARD_CAPABILITIES = {
  textDocument: {
    hover: { contentFormat: ["plaintext"] },
    definition: {},
    implementation: {},
    references: {},
    rename: { prepareSupport: false },
    callHierarchy: { dynamicRegistration: false },
    documentSymbol: { hierarchicalDocumentSymbolSupport: false },
    publishDiagnostics: { relatedInformation: false },
  },
  workspace: {
    workspaceFolders: true,
    workspaceEdit: { documentChanges: true },
    symbol: {},
  },
};

const require = createRequire(import.meta.url);

function packageBinEntry(packageName: string, binName: string): string {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[binName];
  if (!bin) throw new Error(`${packageName} package.json has no ${binName} bin entry`);
  return join(dirname(packageJsonPath), bin);
}

function packagePluginProbeLocation(packageName: string): string {
  let location = dirname(require.resolve(`${packageName}/package.json`));
  for (const _segment of packageName.split("/")) location = dirname(location);
  return dirname(location);
}

function nodeExecPathShim(): string {
  return `data:text/javascript,${encodeURIComponent(`const configured = process.env.${ProcessEnvironmentName.NodeBinary}?.trim(); if (configured) Object.defineProperty(process, 'execPath', { value: configured, configurable: true, writable: true });`)}`;
}

function nodeModuleLaunch(packageName: string, binName: string, args: string[]): { launchCommand: string; launchArgs: string[]; nodeExecPathShim: string } {
  const shim = nodeExecPathShim();
  return { launchCommand: resolveNodeCommand(), launchArgs: [packageBinEntry(packageName, binName), ...args], nodeExecPathShim: shim };
}

function nativeLaunch(binaryName: string, args: string[]): { launchCommand: string; launchArgs: string[] } {
  return { launchCommand: binaryName, launchArgs: args };
}

/** Use Nub's workspace TypeScript, which prepare patches with Effect diagnostics. */
function resolveTypeScriptServerPath(): string {
  return require.resolve("typescript/lib/tsserver.js");
}

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
    rename: { prepareSupport: false },
    documentSymbol: { hierarchicalDocumentSymbolSupport: false },
    publishDiagnostics: { relatedInformation: false },
  },
  workspace: {
    workspaceFolders: true,
    workspaceEdit: { documentChanges: true },
  },
};

const NIX_CAPABILITIES = {
  textDocument: {
    hover: { contentFormat: ["plaintext"] },
    definition: {},
    references: {},
    rename: { prepareSupport: false },
    documentSymbol: { hierarchicalDocumentSymbolSupport: false },
    publishDiagnostics: { relatedInformation: false },
  },
  workspace: {
    workspaceFolders: true,
    workspaceEdit: { documentChanges: true },
    symbol: {},
  },
};

// ─── Backend registry ─────────────────────────────────────────────────────────

export const BACKEND_CONFIGS: LspBackendConfig[] = [
  // ── LSP backends ────────────────────────────────────────────────────────────
  {
    name: BackendName.TypeScript,
    binaryName: "typescript-language-server",
    binaryArgs: ["--stdio"],
    ...nodeModuleLaunch("typescript-language-server", "typescript-language-server", ["--stdio"]),
    extensions: new Map([
      [".ts", "typescript"], [".tsx", "typescriptreact"],
      [".js", "javascript"], [".jsx", "javascriptreact"],
      [".mts", "typescript"], [".cts", "typescript"],
      [".mjs", "javascript"], [".cjs", "javascript"],
    ]),
    capabilities: TS_CAPABILITIES,
    initializationOptions: {
      disableAutomaticTypingAcquisition: true,
      maxTsServerMemory: 768,
      plugins: [
        {
          name: "@effect/language-service",
          location: packagePluginProbeLocation("@effect/language-service"),
        },
      ],
      tsserver: {
        path: resolveTypeScriptServerPath(),
        useSyntaxServer: "never",
      },
    },
    codePrefix: "TS",
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", "bunfig.toml"],
    supportsWorkspaceSymbols: true,
  },
  {
    name: BackendName.Bash,
    binaryName: "bash-language-server",
    binaryArgs: ["start"],
    ...nodeModuleLaunch("bash-language-server", "bash-language-server", ["start"]),
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
    name: BackendName.Nil,
    binaryName: "nil",
    binaryArgs: [],
    ...nativeLaunch("nil", []),
    extensions: new Map([
      [".nix", "nix"],
    ]),
    capabilities: NIX_CAPABILITIES,
    codePrefix: "",
    rootMarkers: ["flake.nix"],
    supportsWorkspaceSymbols: false,
  },
];
