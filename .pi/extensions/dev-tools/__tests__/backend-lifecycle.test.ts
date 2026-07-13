import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveNodeCommand } from "../../../../src/process/platform";
import { LspBackend } from "../backend";

const SIMPLE_LSP = String.raw`
const fs = require("node:fs");
fs.appendFileSync(process.argv[1], "start\n");
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf("\r\n\r\n");
    if (split < 0) return;
    const header = buffer.subarray(0, split).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const end = split + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(split + 4, end).toString("utf8"));
    buffer = buffer.subarray(end);
    if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { capabilities: {} } : null });
    }
    if (message.method === "exit") process.exit(0);
  }
});
`;

function testBackend(countFile: string): LspBackend {
  return new LspBackend({
    mode: "lsp",
    name: "typescript",
    binaryName: "test-language-server",
    binaryArgs: [],
    launchCommand: resolveNodeCommand(),
    launchArgs: ["-e", SIMPLE_LSP, countFile],
    extensions: new Map([[".ts", "typescript"]]),
    rootMarkers: [],
    capabilities: {},
    codePrefix: "TS",
    supportsWorkspaceSymbols: true,
  } as any);
}

describe("LspBackend lifecycle", () => {
  it("coalesces concurrent startup and shutdown, then restarts cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-backend-"));
    const countFile = join(root, "starts");
    const backend = testBackend(countFile);

    try {
      await Promise.all(Array.from({ length: 8 }, () => backend.ensureStarted()));
      expect(backend.isRunning).toBe(true);
      expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);

      await Promise.all([backend.shutdown(), backend.shutdown(), backend.shutdown()]);
      expect(backend.isRunning).toBe(false);

      await Promise.all([backend.ensureStarted(), backend.ensureStarted()]);
      expect(backend.isRunning).toBe(true);
      expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      await backend.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish a child after shutdown overtakes startup", async () => {
    const backend = new LspBackend({
      mode: "lsp",
      name: "typescript",
      binaryName: "test-language-server",
      binaryArgs: [],
      launchCommand: resolveNodeCommand(),
      launchArgs: ["-e", "setInterval(() => {}, 1000)"],
      extensions: new Map([[".ts", "typescript"]]),
      rootMarkers: [],
      capabilities: {},
      codePrefix: "TS",
      supportsWorkspaceSymbols: true,
    } as any);

    const startup = backend.ensureStarted();
    const shutdown = backend.shutdown();

    await shutdown;
    await expect(startup).rejects.toThrow("startup cancelled");
    expect(backend.isRunning).toBe(false);
    await backend.shutdown();
  });
});
