/**
 * Filetype registry — single source of truth for LSP-supported file extensions.
 *
 * Import from here instead of maintaining inline extension sets in each file.
 * All predicate functions use extname() + Set.has() for O(1) lookups with zero allocation.
 */

import { extname } from "node:path";

export const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
export const BASH_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".ksh"]);
export const NIX_EXTENSIONS = new Set([".nix"]);
// HCL is not a language server — hclfmt is invoked directly as a post-edit formatter check.
export const HCL_EXTENSIONS = new Set([".hcl"]);
export const ALL_LSP_EXTENSIONS = new Set([...TS_EXTENSIONS, ...BASH_EXTENSIONS, ...NIX_EXTENSIONS]);

export function isLspSupported(path: string): boolean {
  return ALL_LSP_EXTENSIONS.has(extname(path));
}

export function isTypeScript(path: string): boolean {
  return TS_EXTENSIONS.has(extname(path));
}

export function isBashScript(path: string): boolean {
  return BASH_EXTENSIONS.has(extname(path));
}

export function isNix(path: string): boolean {
  return extname(path) === ".nix";
}

export function isHcl(path: string): boolean {
  return HCL_EXTENSIONS.has(extname(path));
}

export function getLanguageId(path: string): string {
  const ext = extname(path);
  if (ext === ".tsx") return "typescriptreact";
  if (ext === ".jsx") return "javascriptreact";
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "typescript";
  if (BASH_EXTENSIONS.has(ext)) return "shellscript";
  if (ext === ".nix") return "nix";
  return "javascript";
}
