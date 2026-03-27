/**
 * Daemon tests — use a mock LSP subprocess to verify request routing,
 * diagnostics buffering, and workspace management.
 *
 * We test by instantiating LspDaemon with mocked internals rather than
 * spawning a real process, since the goal is to test the routing and
 * formatting logic, not the language servers themselves.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import "../register-actions"; // populate action registry for daemon dispatch
import { LspDaemon } from "../daemon";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serializeRequest, parseResponse, type DaemonRequest } from "../protocol";

describeIfEnabled("dev-tools", "LspDaemon", () => {
  // ─── Helpers ──────────────────────────────────────────────────────────────

  let tmpDir: string;
  let socketPath: string;
  let pidPath: string;
  let daemon: LspDaemon;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lsp-d-"));
    socketPath = join(tmpDir, "t.sock");
    pidPath = join(tmpDir, "t.pid");

    // Create a tsconfig so project root detection works
    writeFileSync(join(tmpDir, "tsconfig.json"), '{"compilerOptions":{}}', "utf8");
  });

  afterEach(async () => {
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch {}
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  // ─── MockedDaemon: replaces LSP subprocess with an in-process mock ────────

  /**
   * Create a LspDaemon with the TypeScript backend's LSP subprocess mocked out.
   * Patches tsBackend directly since diagnostics, lspRequest, etc. now live there.
   */
  function createMockedDaemon(
    lspResponses: Map<string, any> = new Map(),
    diagsByUri: Map<string, any[]> = new Map(),
  ): LspDaemon {
    const d = new LspDaemon(socketPath, pidPath, 60_000);
    const tsBackend = (d as any).tsBackend;

    // Mark TypeScript backend as ready without spawning a real process
    tsBackend.lspReady = true;
    tsBackend.started = true;

    // Override lspRequest to return canned responses
    tsBackend.lspRequest = async (method: string, _params: any) => {
      const result = lspResponses.get(method);
      if (result === undefined) return { jsonrpc: "2.0", id: 1, result: null };
      return { jsonrpc: "2.0", id: 1, result };
    };

    // Override ensureReady so workspace/symbol queries don't spin up LSP
    tsBackend.ensureReady = async () => {};

    // Override ensureFile to return a predictable URI without real LSP calls
    tsBackend.ensureFile = async (p: string) => `file://${resolve(p)}`;

    // Pre-populate diagnostics cache
    for (const [uri, diags] of diagsByUri) {
      tsBackend.diagnostics.publish(uri, diags);
    }

    return d;
  }

  /** Start server and connect, returns socket. */
  async function startAndConnect(d: LspDaemon): Promise<Socket> {
    // Only start the server portion
    await (d as any).startServer();

    return new Promise((resolve, reject) => {
      const sock = connect(socketPath);
      sock.on("connect", () => resolve(sock));
      sock.on("error", reject);
    });
  }

  /** Send a request and wait for response. */
  async function send(sock: Socket, req: DaemonRequest): Promise<ReturnType<typeof parseResponse>> {
    return new Promise((resolve, reject) => {
      let buf = "";
      const handler = (data: string) => {
        buf += data;
        if (buf.includes("\n")) {
          sock.off("data", handler);
          try { resolve(parseResponse(buf.trim())); }
          catch (e) { reject(e); }
        }
      };
      sock.setEncoding("utf8");
      sock.on("data", handler);
      sock.write(serializeRequest(req));
    });
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  describe("status action", () => {
    it("returns running=true and pid", async () => {
      daemon = createMockedDaemon();
      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 1, action: "status" });
      sock.destroy();

      expect(res.ok).toBe(true);
      expect((res.result as any).action).toBe("status");
      expect((res.result as any).running).toBe(true);
    });
  });

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  describe("diagnostics action", () => {
    it("returns error count from cache", async () => {
      const tsFile = join(tmpDir, "broken.ts");
      writeFileSync(tsFile, "const x: string = 42;", "utf8");

      const uri = `file://${resolve(tsFile)}`;
      const diagItems = [
        { line: 1, character: 7, severity: "error", code: "TS2322", message: "Type 'number' is not assignable to type 'string'." },
      ];

      daemon = createMockedDaemon(new Map(), new Map([[uri, diagItems]]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 2, action: "diagnostics", path: tsFile });
      sock.destroy();

      expect(res.ok).toBe(true);
      expect((res.result as any).errorCount).toBe(1);
      expect((res.result as any).items[0].code).toBe("TS2322");
    });

    it("returns no errors when cache is empty", async () => {
      const tsFile = join(tmpDir, "clean.ts");
      writeFileSync(tsFile, "const x: string = 'hello';", "utf8");

      daemon = createMockedDaemon();

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 3, action: "diagnostics", path: tsFile });
      sock.destroy();

      expect(res.ok).toBe(true);
      expect((res.result as any).errorCount).toBe(0);
    });

    it("returns error when path missing", async () => {
      daemon = createMockedDaemon();
      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 4, action: "diagnostics" });
      sock.destroy();

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/path or paths required/);
    });

    it("bulk: returns aggregated results for multiple paths", async () => {
      const fileA = join(tmpDir, "a.ts");
      const fileB = join(tmpDir, "b.ts");
      writeFileSync(fileA, "const x: string = 42;", "utf8");
      writeFileSync(fileB, "const y = 1;", "utf8");

      const uriA = `file://${resolve(fileA)}`;
      const diagA = [
        { line: 1, character: 7, severity: "error", code: "TS2322", message: "Bad type." },
      ];
      daemon = createMockedDaemon(new Map(), new Map([[uriA, diagA]]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 5, action: "diagnostics", paths: [fileA, fileB] });
      sock.destroy();

      expect(res.ok).toBe(true);
      const r = res.result as any;
      expect(r.action).toBe("diagnostics");
      expect(r.files).toHaveLength(2);
      expect(r.files[0].errorCount).toBe(1);
      expect(r.files[1].errorCount).toBe(0);
      expect(r.errorCount).toBe(1);
      expect(r.warnCount).toBe(0);
    });

    it("bulk: deduplicates paths", async () => {
      const fileA = join(tmpDir, "dup.ts");
      writeFileSync(fileA, "const x = 1;", "utf8");
      daemon = createMockedDaemon();

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 6, action: "diagnostics", paths: [fileA, fileA, fileA] });
      sock.destroy();

      expect(res.ok).toBe(true);
      expect((res.result as any).files).toHaveLength(1);
    });

    it("bulk: reports fileErrors for non-existent paths without losing valid results", async () => {
      const fileA = join(tmpDir, "exists.ts");
      writeFileSync(fileA, "const x = 1;", "utf8");
      daemon = createMockedDaemon();

      const sock = await startAndConnect(daemon);
      const res = await send(sock, {
        id: 7, action: "diagnostics",
        paths: [fileA, join(tmpDir, "nope.ts")],
      });
      sock.destroy();

      expect(res.ok).toBe(true);
      const r = res.result as any;
      expect(r.files).toHaveLength(1);
      expect(r.fileErrors).toHaveLength(1);
      expect(r.fileErrors[0]).toContain("File not found");
    });
  });

  // ─── Hover ────────────────────────────────────────────────────────────────

  describe("hover action", () => {
    it("returns signature from LSP hover response", async () => {
      const tsFile = join(tmpDir, "types.ts");
      writeFileSync(tsFile, "const greeting: string = 'hello';", "utf8");

      daemon = createMockedDaemon(new Map([
        ["textDocument/hover", {
          contents: { kind: "markdown", value: "```typescript\nconst greeting: string\n```" },
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
        }],
      ]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 5, action: "hover", path: tsFile, line: 1, character: 7 });
      sock.destroy();

      expect(res.ok).toBe(true);
      expect((res.result as any).action).toBe("hover");
      expect((res.result as any).signature).toContain("const greeting: string");
    });

    it("returns error when LSP returns null", async () => {
      const tsFile = join(tmpDir, "foo.ts");
      writeFileSync(tsFile, "const x = 1;", "utf8");

      daemon = createMockedDaemon(new Map([["textDocument/hover", null]]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 6, action: "hover", path: tsFile, line: 1, character: 1 });
      sock.destroy();

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/No hover information/);
    });

    it("returns error when params missing", async () => {
      daemon = createMockedDaemon();
      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 7, action: "hover", path: "/foo.ts" });
      sock.destroy();

      expect(res.ok).toBe(false);
    });
  });

  // ─── Definition ───────────────────────────────────────────────────────────

  describe("definition action", () => {
    it("returns location with body", async () => {
      const typesFile = join(tmpDir, "types.ts");
      writeFileSync(typesFile, "interface User {\n  name: string;\n  age: number;\n}\n", "utf8");

      const uri = `file://${resolve(typesFile)}`;
      daemon = createMockedDaemon(new Map([
        ["textDocument/definition", [
          {
            uri,
            range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          },
        ]],
      ]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 8, action: "definition", path: typesFile, line: 1, character: 1 });
      sock.destroy();

      expect(res.ok).toBe(true);
      expect((res.result as any).locations).toHaveLength(1);
      expect((res.result as any).locations[0].body).toContain("interface User");
    });

    it("returns error when LSP returns null", async () => {
      const tsFile = join(tmpDir, "foo.ts");
      writeFileSync(tsFile, "const x = 1;", "utf8");

      daemon = createMockedDaemon(new Map([["textDocument/definition", null]]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 9, action: "definition", path: tsFile, line: 1, character: 1 });
      sock.destroy();

      expect(res.ok).toBe(false);
    });
  });

  // ─── References ───────────────────────────────────────────────────────────

  describe("references action", () => {
    it("returns items from LSP response", async () => {
      const srcFile = join(tmpDir, "src.ts");
      writeFileSync(srcFile, "function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n", "utf8");

      const uri = `file://${resolve(srcFile)}`;
      daemon = createMockedDaemon(new Map([
        ["textDocument/references", [
          { uri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } } },
          { uri, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } },
        ]],
      ]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 10, action: "references", path: srcFile, line: 1, character: 10 });
      sock.destroy();

      expect(res.ok).toBe(true);
      expect((res.result as any).total).toBe(2);
      expect((res.result as any).items).toHaveLength(2);
    });

    it("returns empty items for no references", async () => {
      const tsFile = join(tmpDir, "x.ts");
      writeFileSync(tsFile, "const x = 1;", "utf8");

      daemon = createMockedDaemon(new Map([["textDocument/references", null]]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 11, action: "references", path: tsFile, line: 1, character: 1 });
      sock.destroy();

      expect(res.ok).toBe(true);
      expect((res.result as any).total).toBe(0);
    });
  });

  // ─── Symbols ─────────────────────────────────────────────────────────────

  describe("symbols action", () => {
    it("returns document symbols for a file", async () => {
      const tsFile = join(tmpDir, "types.ts");
      writeFileSync(tsFile, "interface Foo {}\nfunction bar() {}\n", "utf8");

      daemon = createMockedDaemon(new Map([
        ["textDocument/documentSymbol", [
          { name: "Foo", kind: 11, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 16 } }, selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } } },
          { name: "bar", kind: 12, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 17 } }, selectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 12 } } },
        ]],
      ]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 12, action: "symbols", path: tsFile });
      sock.destroy();

      expect(res.ok).toBe(true);
      const result = res.result as any;
      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe("Foo");
      expect(result.items[0].kind).toBe("interface");
    });

    it("returns workspace symbols for a query", async () => {
      const tsFile = join(tmpDir, "types.ts");
      writeFileSync(tsFile, "interface User {}", "utf8");
      const uri = `file://${resolve(tsFile)}`;

      daemon = createMockedDaemon(new Map([
        ["workspace/symbol", [
          {
            name: "User",
            kind: 11,
            location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 17 } } },
          },
        ]],
      ]));

      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 13, action: "symbols", query: "User" });
      sock.destroy();

      expect(res.ok).toBe(true);
      const result = res.result as any;
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("User");
    });

    it("returns error when neither path nor query given", async () => {
      daemon = createMockedDaemon();
      const sock = await startAndConnect(daemon);
      const res = await send(sock, { id: 14, action: "symbols" });
      sock.destroy();

      expect(res.ok).toBe(false);
    });
  });

  // ─── Invalid JSON ─────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns error for invalid JSON request", async () => {
      daemon = createMockedDaemon();
      const sock = await startAndConnect(daemon);

      const res = await new Promise<ReturnType<typeof parseResponse>>((resolve, reject) => {
        let buf = "";
        sock.setEncoding("utf8");
        sock.on("data", (d: string) => {
          buf += d;
          if (buf.includes("\n")) {
            sock.off("data", () => {});
            try { resolve(parseResponse(buf.trim())); }
            catch (e) { reject(e); }
          }
        });
        sock.write("{not valid json}\n");
      });
      sock.destroy();

      expect(res.ok).toBe(false);
    });
  });

  // ─── onDiagnostics (internal, tested via tsBackend) ───────────────────────

  describe("onDiagnostics (internal)", () => {
    it("caches diagnostics by URI", () => {
      daemon = createMockedDaemon();
      const tsBackend = (daemon as any).tsBackend;
      const uri = "file:///test.ts";

      (tsBackend as any).onDiagnostics({
        uri,
        diagnostics: [
          { range: { start: { line: 4, character: 2 } }, severity: 1, code: 2339, message: "Property 'x' does not exist on type 'Y'." },
          { range: { start: { line: 7, character: 0 } }, severity: 2, code: 7017, message: "Element implicitly has an 'any' type." },
        ],
      });

      const cached = tsBackend.diagnostics.get(uri) as any[];
      expect(cached).toHaveLength(2);
      expect(cached[0].severity).toBe("error");
      expect(cached[0].code).toBe("TS2339");
      expect(cached[0].line).toBe(5); // 0-indexed → 1-indexed
      expect(cached[0].character).toBe(3);
      expect(cached[1].severity).toBe("warning");
    });

    it("truncates diagnostic message at 200 characters", () => {
      daemon = createMockedDaemon();
      const tsBackend = (daemon as any).tsBackend;
      const uri = "file:///test.ts";
      const longMsg = "A".repeat(250);

      (tsBackend as any).onDiagnostics({
        uri,
        diagnostics: [
          { range: { start: { line: 0, character: 0 } }, severity: 1, code: 2322, message: longMsg },
        ],
      });

      const cached = tsBackend.diagnostics.get(uri) as any[];
      expect(cached[0].message).toBe("A".repeat(200) + "…");
    });

    it("does not truncate messages under 200 characters", () => {
      daemon = createMockedDaemon();
      const tsBackend = (daemon as any).tsBackend;
      const uri = "file:///test2.ts";
      const msg = "Type 'number' is not assignable to type 'string'. Did you mean 'foo'?";

      (tsBackend as any).onDiagnostics({
        uri,
        diagnostics: [
          { range: { start: { line: 0, character: 0 } }, severity: 1, code: 2322, message: msg },
        ],
      });

      const cached = tsBackend.diagnostics.get(uri) as any[];
      expect(cached[0].message).toBe(msg);
    });
  });
});
