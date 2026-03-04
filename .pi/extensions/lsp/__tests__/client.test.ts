/**
 * Client tests — mock socket server to verify connect/retry/timeout behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { LspClient } from "../client";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeResponse, okResponse, errorResponse, type DaemonResponse, type StatusResult } from "../protocol";

describeIfEnabled("lsp", "LspClient", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: Server | null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lsp-client-test-"));
    const suffix = Date.now() + Math.random().toString(36).slice(2);
    socketPath = join(tmpDir, `client-test-${suffix}.sock`);
    server = null;
  });

  afterEach(async () => {
    await closeServer();
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  // ─── Helpers ────────────────────────────────────────────────────────────

  function startMockServer(handler: (req: any, sock: Socket) => void): Promise<Server> {
    return new Promise((resolve, reject) => {
      server = createServer((sock) => {
        let buf = "";
        sock.setEncoding("utf8");
        sock.on("data", (data: string) => {
          buf += data;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) {
              try { handler(JSON.parse(line), sock); } catch {}
            }
          }
        });
      });
      server!.on("error", reject);
      server!.listen(socketPath, () => resolve(server!));
    });
  }

  function closeServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!server) { resolve(); return; }
      server.close(() => resolve());
      server = null;
    });
  }

  function createClient(): LspClient {
    // Use a no-op spawnDaemon since we manage the server ourselves
    const client = new LspClient(socketPath, join(tmpDir, "test.pid"), join(tmpDir, "daemon.ts"));
    (client as any).spawnDaemon = async () => {};
    return client;
  }

  // ─── Basic request/response ──────────────────────────────────────────────

  describe("request", () => {
    it("sends request and receives response", async () => {
      const statusResult: StatusResult = {
        action: "status", running: true, pid: 999, projects: [], watchedFiles: 0, idleMs: 100,
      };

      await startMockServer((req, sock) => {
        sock.write(serializeResponse(okResponse(req.id, statusResult)));
      });

      const client = createClient();
      const res = await client.request({ action: "status" });
      client.close();

      expect(res.ok).toBe(true);
      expect((res.result as any).running).toBe(true);
    });

    it("returns error response when server returns error", async () => {
      await startMockServer((req, sock) => {
        sock.write(serializeResponse(errorResponse(req.id, "something broke")));
      });

      const client = createClient();
      const res = await client.request({ action: "status" });
      client.close();

      expect(res.ok).toBe(false);
      expect(res.error).toBe("something broke");
    });

    it("assigns unique ids to concurrent requests", async () => {
      const received: number[] = [];
      const statusResult: StatusResult = {
        action: "status", running: true, projects: [], watchedFiles: 0, idleMs: 0,
      };

      await startMockServer((req, sock) => {
        received.push(req.id);
        sock.write(serializeResponse(okResponse(req.id, statusResult)));
      });

      const client = createClient();
      await Promise.all([
        client.request({ action: "status" }),
        client.request({ action: "status" }),
        client.request({ action: "status" }),
      ]);
      client.close();

      // All IDs should be unique
      const unique = new Set(received);
      expect(unique.size).toBe(3);
    });
  });

  // ─── call() ─────────────────────────────────────────────────────────────

  describe("call", () => {
    it("unwraps result on success", async () => {
      const statusResult: StatusResult = {
        action: "status", running: true, projects: ["/proj"], watchedFiles: 2, idleMs: 500,
      };

      await startMockServer((req, sock) => {
        sock.write(serializeResponse(okResponse(req.id, statusResult)));
      });

      const client = createClient();
      const result = await client.call({ action: "status" });
      client.close();

      expect((result as any).projects).toEqual(["/proj"]);
    });

    it("throws on error response", async () => {
      await startMockServer((req, sock) => {
        sock.write(serializeResponse(errorResponse(req.id, "no path")));
      });

      const client = createClient();
      expect(client.call({ action: "diagnostics" })).rejects.toThrow("no path");
      client.close();
    });
  });

  // ─── Connection retry ────────────────────────────────────────────────────

  describe("connection retry", () => {
    it("connects after server starts with delay", async () => {
      const statusResult: StatusResult = {
        action: "status", running: true, projects: [], watchedFiles: 0, idleMs: 0,
      };

      // Start server 300ms after client tries to connect
      setTimeout(async () => {
        await startMockServer((req, sock) => {
          sock.write(serializeResponse(okResponse(req.id, statusResult)));
        });
      }, 300);

      const client = createClient();
      const res = await client.request({ action: "status" });
      client.close();

      expect(res.ok).toBe(true);
    });
  });

  // ─── close() ────────────────────────────────────────────────────────────

  describe("close", () => {
    it("rejects pending requests on close", async () => {
      // Server that never responds
      await startMockServer(() => {});

      const client = createClient();
      const reqPromise = client.request({ action: "status" });
      await new Promise((r) => setTimeout(r, 50)); // let it connect
      client.close();

      expect(reqPromise).rejects.toThrow("Client closed");
    });
  });
});
