import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { resolveNodeCommand } from "../../../../src/process/platform";
import { makeToolingTelemetryRuntime } from "../../../../src/telemetry/tooling";
import { LspBackend } from "../backend";
import { LspDaemon } from "../daemon";
import { parseResponse, serializeRequest } from "../protocol";
import { DevToolsSpanName } from "../telemetry";

const SIMPLE_LSP = String.raw`
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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inMemoryExporter(finished: ReadableSpan[]): SpanExporter {
  return {
    export: (spans, callback) => {
      finished.push(...spans);
      callback({ code: 0 });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

async function telemetryRuntime(finished: ReadableSpan[]) {
  return Effect.runPromise(
    makeToolingTelemetryRuntime({
      env: {
        PI_ENV_TOOLING_OTEL_ENABLED: "true",
        PI_ENV_TOOLING_OTEL_ENDPOINT: "http://collector:4318",
      },
      exporter: inMemoryExporter(finished),
      serviceName: "pi-env-dev-tools-test",
    }),
  );
}

function sendDaemonRequest(
  socketPath: string,
  request: Parameters<typeof serializeRequest>[0],
): Promise<ReturnType<typeof parseResponse>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(serializeRequest(request)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      resolve(parseResponse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });
}

function assertSafeSpans(finished: ReadableSpan[], sentinels: string[]): void {
  const allowed = new Set(["operation", "backend", "action", "method", "outcome", "error_kind"]);
  for (const span of finished) {
    expect(Object.keys(span.attributes).every((key) => allowed.has(key))).toBe(true);
  }
  const exported = JSON.stringify(
    finished.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    })),
  );
  for (const sentinel of sentinels) expect(exported).not.toContain(sentinel);
}

describe("dev-tools tooling telemetry", () => {
  it("emits bounded backend lifecycle spans without request params or paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "dev-tools-secret-path-"));
    roots.push(root);
    const pathSentinel = join(root, "private-file.ts");
    const paramsSentinel = "private-request-params";
    const finished: ReadableSpan[] = [];
    const runtime = await telemetryRuntime(finished);
    const backend = new LspBackend(
      {
        mode: "lsp",
        name: "typescript",
        binaryName: "test-language-server",
        binaryArgs: [],
        launchCommand: resolveNodeCommand(),
        launchArgs: ["-e", SIMPLE_LSP],
        extensions: new Map([[".ts", "typescript"]]),
        rootMarkers: [],
        capabilities: {},
        codePrefix: "TS",
        supportsWorkspaceSymbols: true,
      } as any,
      runtime,
    );

    try {
      await backend.ensureStarted();
      await backend.lspRequest("textDocument/hover", {
        textDocument: { uri: `file://${pathSentinel}` },
        sentinel: paramsSentinel,
      });
      await backend.shutdown();
    } finally {
      await Effect.runPromise(runtime.disposeEffect);
    }

    expect(finished.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        DevToolsSpanName.BackendStartup,
        DevToolsSpanName.BackendInitialize,
        DevToolsSpanName.BackendRequest,
        DevToolsSpanName.BackendShutdown,
      ]),
    );
    expect(
      finished.find((span) => span.name === DevToolsSpanName.BackendRequest)?.attributes,
    ).toMatchObject({
      operation: "request",
      backend: "typescript",
      method: "textDocument/hover",
      outcome: "success",
    });
    assertSafeSpans(finished, [root, pathSentinel, paramsSentinel, "file://"]);
  });

  it("emits a sanitized daemon request span and disposes its shared runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "dev-tools-daemon-otel-"));
    roots.push(root);
    const socketPath = join(root, "daemon.sock");
    const pidPath = join(root, "daemon.pid");
    const privateFile = join(root, "private-file.ts");
    writeFileSync(privateFile, "const value = 1;\n");
    const finished: ReadableSpan[] = [];
    const runtime = await telemetryRuntime(finished);
    const daemon = new LspDaemon(socketPath, pidPath, 60_000, runtime);
    const backend = new LspBackend(
      {
        mode: "lsp",
        name: "typescript",
        binaryName: "test-language-server",
        binaryArgs: [],
        launchCommand: resolveNodeCommand(),
        launchArgs: ["-e", SIMPLE_LSP],
        extensions: new Map([[".ts", "typescript"]]),
        rootMarkers: [],
        capabilities: {},
        codePrefix: "TS",
        supportsWorkspaceSymbols: true,
      } as any,
      runtime,
    );
    (daemon as any).backends = [backend];

    await daemon.start();
    const response = await sendDaemonRequest(socketPath, {
      id: 1,
      action: "hover",
      path: privateFile,
      line: 1,
      character: 1,
    });
    expect(response).toMatchObject({ id: 1, ok: false });
    const unknownAction = "private-unbounded-action";
    const unknown = await sendDaemonRequest(socketPath, {
      id: 2,
      action: unknownAction,
    } as any);
    expect(unknown).toMatchObject({ id: 2, ok: false });
    await daemon.shutdown();

    const daemonSpan = finished.find((span) => span.name === DevToolsSpanName.DaemonRequest);
    const backendSpan = finished.find(
      (span) => span.name === DevToolsSpanName.BackendRequest,
    );
    expect(daemonSpan?.attributes).toMatchObject({
      operation: "daemon_request",
      action: "hover",
      outcome: "success",
    });
    expect(backendSpan?.parentSpanContext?.spanId).toBe(daemonSpan?.spanContext().spanId);
    expect(
      finished.find(
        (span) =>
          span.name === DevToolsSpanName.DaemonRequest && span.attributes.action === "unknown",
      ),
    ).toBeDefined();
    assertSafeSpans(finished, [
      root,
      socketPath,
      pidPath,
      privateFile,
      unknownAction,
    ]);
  });
});
