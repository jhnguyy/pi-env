/**
 * Document manager — tracks open files and project roots for the LSP daemon.
 *
 * Responsibilities:
 * - Detect project root (nearest tsconfig.json / jsconfig.json)
 * - Cache file → project root mapping
 * - Track which files are currently open in the LSP
 * - Generate textDocument/didOpen, didChange, didClose notifications
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToUri } from "./utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenDocument {
  uri: string;
  absolutePath: string;
  projectRoot: string;
  languageId: string;
  version: number;
  content: string;
  /** Monotonic access counter for LRU eviction. */
  lastAccess: number;
}

/** Maximum number of documents kept open simultaneously. LRU eviction kicks in above this. */
export const MAX_OPEN_DOCUMENTS = 50;

// ─── DocumentManager ─────────────────────────────────────────────────────────

export class DocumentManager {
  /** uri → OpenDocument */
  private openDocs = new Map<string, OpenDocument>();

  /** file path → project root (cache) */
  private rootCache = new Map<string, string>();

  /** project root → set of file URIs open in that project */
  private projectFiles = new Map<string, Set<string>>();

  /** Monotonic counter for LRU tracking. */
  private accessCounter = 0;

  constructor(
    /** Resolve a file path to its LSP languageId. Provided by the owning backend. */
    private resolveLanguageId: (path: string) => string,
    /** Resolve a file path to its project root, or null. Provided by the owning backend. */
    private resolveProjectRoot: (path: string) => string | null,
  ) {}

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
    const languageId = this.resolveLanguageId(abs);
    const existing = this.openDocs.get(uri);
    const isNewRoot = !this.projectFiles.has(projectRoot);

    // Register project
    if (!this.projectFiles.has(projectRoot)) {
      this.projectFiles.set(projectRoot, new Set());
    }
    this.projectFiles.get(projectRoot)!.add(uri);

    if (!existing) {
      // New document
      const doc: OpenDocument = {
        uri, absolutePath: abs, projectRoot, languageId,
        version: 1, content, lastAccess: ++this.accessCounter,
      };
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

    // Touch for LRU
    existing.lastAccess = ++this.accessCounter;

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

    const root = this.resolveProjectRoot(abs) ?? dirname(abs);
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

  /** Number of currently open documents. */
  get openCount(): number {
    return this.openDocs.size;
  }

  /**
   * Evict the least-recently-used documents down to the limit.
   * Returns the URIs that were evicted (caller should send didClose).
   */
  evict(maxOpen: number = MAX_OPEN_DOCUMENTS): string[] {
    if (this.openDocs.size <= maxOpen) return [];

    const sorted = [...this.openDocs.values()]
      .sort((a, b) => a.lastAccess - b.lastAccess);

    const toEvict = sorted.slice(0, this.openDocs.size - maxOpen);
    const evictedUris: string[] = [];

    for (const doc of toEvict) {
      this.openDocs.delete(doc.uri);
      const projectFiles = this.projectFiles.get(doc.projectRoot);
      if (projectFiles) {
        projectFiles.delete(doc.uri);
        if (projectFiles.size === 0) this.projectFiles.delete(doc.projectRoot);
      }
      evictedUris.push(doc.uri);
    }

    return evictedUris;
  }

  /**
   * Close a single document and remove it from tracking.
   * Returns the URI if it was open, null if not found.
   * Caller is responsible for sending textDocument/didClose to the LSP.
   */
  close(absolutePath: string): string | null {
    const abs = resolve(absolutePath);
    const uri = pathToUri(abs);
    const doc = this.openDocs.get(uri);
    if (!doc) return null;
    this.openDocs.delete(uri);
    const projectFiles = this.projectFiles.get(doc.projectRoot);
    if (projectFiles) {
      projectFiles.delete(uri);
      if (projectFiles.size === 0) this.projectFiles.delete(doc.projectRoot);
    }
    return uri;
  }

  /** Close all documents. */
  clear(): void {
    this.openDocs.clear();
    this.rootCache.clear();
    this.projectFiles.clear();
  }
}
