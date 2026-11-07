import { pathToFileURL } from "node:url";
import type { HandlerBackend } from "../handlers";
import type { DiagnosticItem } from "../protocol";
import type { LspMessage } from "../lsp-transport";

/** Controlled handler collaborator: no subprocess, timers, or private backend state. */
export class ControlledBackend implements HandlerBackend {
  readonly responses = new Map<string, unknown>();
  readonly failures = new Map<string, unknown>();
  readonly diagnostics = new Map<string, DiagnosticItem[]>();
  readonly requests: { method: string; params: unknown }[] = [];
  readonly opened: string[] = [];
  openUris: string[] = [];
  supportsWorkspaceSymbols = true;
  lastSemanticRequest?: { method: string; itemCount: number };
  shutdownCalls = 0;
  onShutdown: () => Promise<void> = async () => {};

  constructor(
    readonly root: string,
    readonly name = "typescript",
    readonly extension = ".ts",
    public projectRoots = [root],
  ) {}

  handles(path: string): boolean {
    return path.endsWith(this.extension);
  }
  async ensureFile(path: string): Promise<string> {
    this.opened.push(path);
    return pathToFileURL(path).href;
  }
  async ensureReady(): Promise<void> {}
  getProjectRoot(): string {
    return this.root;
  }
  getDocumentSnapshot(): undefined {
    return undefined;
  }
  async lspRequest(method: string, params: unknown): Promise<LspMessage> {
    this.requests.push({ method, params });
    if (this.failures.has(method)) throw this.failures.get(method);
    return { jsonrpc: "2.0", id: 1, result: this.responses.get(method) ?? null };
  }
  recordSemanticResult(method: string, itemCount: number): void {
    this.lastSemanticRequest = { method, itemCount };
  }
  async waitForDiagnostics(): Promise<void> {}
  getDiagnostics(uri: string): DiagnosticItem[] {
    return this.diagnostics.get(uri) ?? [];
  }
  getStatusSnapshot(): ReturnType<HandlerBackend["getStatusSnapshot"]> {
    return {
      name: this.name,
      running: true,
      initializationState: "initialized",
      semanticAvailable: this.lastSemanticRequest != null,
      lastSemanticRequest: this.lastSemanticRequest,
      projectMode: "unknown",
    };
  }
  async shutdown(): Promise<void> {
    this.shutdownCalls++;
    await this.onShutdown();
  }
}
