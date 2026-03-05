/**
 * Document manager — tracks open files and project roots for the LSP daemon.
 *
 * Responsibilities:
 * - Detect project root (nearest tsconfig.json / jsconfig.json)
 * - Cache file → project root mapping
 * - Track which files are currently open in the LSP
 * - Generate textDocument/didOpen, didChange, didClose notifications
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findProjectRoot, pathToUri } from "./utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenDocument {
  uri: string;
  absolutePath: string;
  projectRoot: string;
  languageId: string;
  version: number;
  content: string;
}

// ─── DocumentManager ─────────────────────────────────────────────────────────

export class DocumentManager {
  /** uri → OpenDocument */
  private openDocs = new Map<string, OpenDocument>();

  /** file path → project root (cache) */
  private rootCache = new Map<string, string>();

  /** project root → set of file URIs open in that project */
  private projectFiles = new Map<string, Set<string>>();

  /**
   * Open or refresh a document. If the document is already open with the same
   * content, returns null (no LSP notification needed). Otherwise returns the
   * notification params to send.
   */
  private open(absolutePath: string): {
    notification: "didOpen" | "didChange";
    params: object;
    isNewRoot: boolean;
    projectRoot: string;
  } | null {
    const abs = resolve(absolutePath);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      return null;
    }

    const uri = pathToUri(abs);
    const projectRoot = this.getProjectRoot(abs);
    const languageId = getLanguageId(abs);
    const existing = this.openDocs.get(uri);
    const isNewRoot = !this.projectFiles.has(projectRoot);

    // Register project
    if (!this.projectFiles.has(projectRoot)) {
      this.projectFiles.set(projectRoot, new Set());
    }
    this.projectFiles.get(projectRoot)!.add(uri);

    if (!existing) {
      // New document
      const doc: OpenDocument = { uri, absolutePath: abs, projectRoot, languageId, version: 1, content };
      this.openDocs.set(uri, doc);
      return {
        notification: "didOpen",
        params: {
          textDocument: { uri, languageId, version: 1, text: content },
        },
        isNewRoot,
        projectRoot,
      };
    }

    if (existing.content === content) {
      return null; // nothing changed
    }

    // Content changed
    existing.version++;
    existing.content = content;
    return {
      notification: "didChange",
      params: {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: content }],
      },
      isNewRoot: false,
      projectRoot,
    };
  }

  /**
   * Ensure a file is open. Returns the notification (if needed) plus the URI.
   * Returns { uri, notification: null } if already open and unchanged.
   */
  ensure(absolutePath: string): {
    uri: string;
    projectRoot: string;
    notification: { type: "didOpen" | "didChange"; params: object } | null;
    isNewRoot: boolean;
  } {
    const abs = resolve(absolutePath);
    const uri = pathToUri(abs);
    const result = this.open(abs);

    if (!result) {
      return { uri, projectRoot: this.getProjectRoot(abs), notification: null, isNewRoot: false };
    }

    return {
      uri,
      projectRoot: result.projectRoot,
      notification: { type: result.notification, params: result.params },
      isNewRoot: result.isNewRoot,
    };
  }

  /** Get the project root for a file path (cached). */
  getProjectRoot(absolutePath: string): string {
    const abs = resolve(absolutePath);
    const cached = this.rootCache.get(abs);
    if (cached) return cached;

    const root = findProjectRoot(abs) ?? dirname(abs);
    this.rootCache.set(abs, root);
    return root;
  }

  /** Returns true if any file in this project root is open. */
  hasProject(projectRoot: string): boolean {
    const files = this.projectFiles.get(resolve(projectRoot));
    return !!files && files.size > 0;
  }

  /** Returns all known project roots. */
  get projectRoots(): string[] {
    return Array.from(this.projectFiles.keys());
  }

  /** Returns all currently open document URIs. */
  get openUris(): string[] {
    return Array.from(this.openDocs.keys());
  }

  /** Returns the open document for a URI, if any. */
  getDoc(uri: string): OpenDocument | undefined {
    return this.openDocs.get(uri);
  }

  /** Close all documents. */
  clear(): void {
    this.openDocs.clear();
    this.rootCache.clear();
    this.projectFiles.clear();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLanguageId(path: string): string {
  if (path.endsWith(".tsx")) return "typescriptreact";
  if (path.endsWith(".jsx")) return "javascriptreact";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
  if (path.endsWith(".sh") || path.endsWith(".bash") || path.endsWith(".zsh") || path.endsWith(".ksh")) return "shellscript";
  return "javascript";
}
