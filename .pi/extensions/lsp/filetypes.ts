/**
 * Filetype registry — single source of truth for LSP-supported file extensions.
 *
 * Import from here instead of maintaining inline extension sets in each file.
 */

export const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
export const BASH_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".ksh"]);
export const ALL_LSP_EXTENSIONS = new Set([...TS_EXTENSIONS, ...BASH_EXTENSIONS]);

export function isLspSupported(path: string): boolean {
  return [...ALL_LSP_EXTENSIONS].some(ext => path.endsWith(ext));
}

export function isTypeScript(path: string): boolean {
  return [...TS_EXTENSIONS].some(ext => path.endsWith(ext));
}

export function isBashScript(path: string): boolean {
  return [...BASH_EXTENSIONS].some(ext => path.endsWith(ext));
}

export function getLanguageId(path: string): string {
  if (path.endsWith(".tsx")) return "typescriptreact";
  if (path.endsWith(".jsx")) return "javascriptreact";
  if ([".ts", ".mts", ".cts"].some(e => path.endsWith(e))) return "typescript";
  if (isBashScript(path)) return "shellscript";
  return "javascript";
}
