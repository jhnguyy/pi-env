import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDaemonRequestExecutor } from "../daemon-request";
import { FileCache } from "../file-cache";
import type { DaemonRequest, DaemonResponse, LspResult } from "../protocol";
import { ControlledBackend } from "./controlled-backend";

function result<A extends LspResult["action"]>(
  response: DaemonResponse,
  action: A,
): Extract<LspResult, { action: A }> {
  expect(response.ok).toBe(true);
  expect(response.result?.action).toBe(action);
  return response.result as Extract<LspResult, { action: A }>;
}

const range = (line = 0) => ({ start: { line, character: 0 }, end: { line, character: 10 } });

describe("parsed daemon requests", () => {
  let root: string;
  let backend: ControlledBackend;
  let execute: ReturnType<typeof createDaemonRequestExecutor>;
  const request = (
    action: DaemonRequest["action"],
    fields: Partial<DaemonRequest> = {},
  ): DaemonRequest => ({
    id: 41,
    action,
    ...fields,
  });
  const position = () => ({ path: join(root, "source.ts"), line: 1, character: 7 });
  const file = (name: string, body = "const value = 1;\n") => {
    const path = join(root, name);
    writeFileSync(path, body);
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "daemon-request-"));
    backend = new ControlledBackend(root);
    execute = createDaemonRequestExecutor({
      backends: [backend],
      fileCache: new FileCache(),
      getIdleMs: () => 123,
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns running status, pid, prior idle time and request ID", async () => {
    const response = await execute(request("status"));
    expect(response.id).toBe(41);
    expect(result(response, "status")).toMatchObject({
      running: true,
      pid: process.pid,
      idleMs: 123,
    });
  });

  it("returns the shutdown acknowledgement without owning cleanup", async () => {
    const response = await execute(request("shutdown"));
    expect(response).toMatchObject({
      id: 41,
      ok: true,
      result: { action: "status", running: false },
    });
    expect(backend.shutdownCalls).toBe(0);
  });

  it("returns error and warning counts from cached diagnostics", async () => {
    const path = file("broken.ts");
    backend.diagnostics.set(pathToFileURL(path).href, [
      { line: 1, character: 7, severity: "error", code: "TS2322", message: "Bad type." },
      { line: 2, character: 1, severity: "warning", code: "TS7017", message: "Warning." },
    ]);
    expect(result(await execute(request("diagnostics", { path })), "diagnostics")).toMatchObject({
      path,
      errorCount: 1,
      warnCount: 1,
      items: [{ code: "TS2322" }, { code: "TS7017" }],
    });
  });

  it("returns no errors when the cache is empty", async () => {
    expect(
      result(await execute(request("diagnostics", { path: file("clean.ts") })), "diagnostics"),
    ).toMatchObject({
      errorCount: 0,
      warnCount: 0,
      items: [],
    });
  });

  it("rejects diagnostics without a path", async () => {
    expect(await execute(request("diagnostics"))).toEqual({
      id: 41,
      ok: false,
      error: "path or paths required for diagnostics",
    });
  });

  it("bulk diagnostics aggregate counts and preserve input order", async () => {
    const a = file("a.ts");
    const b = file("b.ts");
    backend.diagnostics.set(pathToFileURL(a).href, [
      { line: 1, character: 1, severity: "error", code: "TS2322", message: "Bad type." },
    ]);
    const response = result(
      await execute(request("diagnostics", { paths: [b, a] })),
      "diagnostics",
    );
    expect(response.files?.map(({ path, errorCount }) => ({ path, errorCount }))).toEqual([
      { path: b, errorCount: 0 },
      { path: a, errorCount: 1 },
    ]);
    expect(response).toMatchObject({ errorCount: 1, warnCount: 0 });
  });

  it("bulk diagnostics deduplicate paths before opening files", async () => {
    const path = file("duplicate.ts");
    const response = result(
      await execute(request("diagnostics", { paths: [path, path, path] })),
      "diagnostics",
    );
    expect(response.files).toHaveLength(1);
    expect(backend.opened).toEqual([path]);
  });

  it("bulk diagnostics retain valid results alongside missing-file errors", async () => {
    const path = file("exists.ts");
    const missing = join(root, "missing.ts");
    const response = result(
      await execute(request("diagnostics", { paths: [path, missing] })),
      "diagnostics",
    );
    expect(response.files).toHaveLength(1);
    expect(response.files?.[0].path).toBe(path);
    expect(response.fileErrors).toEqual([`${missing}: File not found: ${missing}`]);
  });

  it("returns hover signature and translates one-based positions", async () => {
    backend.responses.set("textDocument/hover", {
      contents: { kind: "markdown", value: "```typescript\nconst greeting: string\n```" },
    });
    expect(result(await execute(request("hover", position())), "hover").signature).toBe(
      "const greeting: string",
    );
    expect(backend.requests[0]).toEqual({
      method: "textDocument/hover",
      params: {
        textDocument: { uri: pathToFileURL(position().path).href },
        position: { line: 0, character: 6 },
      },
    });
  });

  it.each([
    ["hover", "textDocument/hover", "No hover information at this position"],
    ["definition", "textDocument/definition", "No definition found"],
  ] as const)(
    "records valid empty %s while preserving the public error",
    async (action, method, error) => {
      expect(await execute(request(action, position()))).toEqual({ id: 41, ok: false, error });
      expect(result(await execute(request("status")), "status").semantic.lastRequest).toEqual({
        method,
        itemCount: 0,
      });
    },
  );

  it("rejects hover with missing position parameters", async () => {
    expect(await execute(request("hover", { path: position().path }))).toEqual({
      id: 41,
      ok: false,
      error: "path, line, and character required for hover",
    });
  });

  it.each(["definition", "implementation"] as const)(
    "returns a %s location with real source body",
    async (action) => {
      const path = file("types.ts", "interface User {\n  name: string;\n  age: number;\n}\n");
      backend.responses.set(`textDocument/${action}`, [
        {
          uri: pathToFileURL(path).href,
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
        },
      ]);
      const response = result(await execute(request(action, position())), action);
      expect(response.locations).toHaveLength(1);
      expect(response.locations[0]).toMatchObject({
        absolutePath: path,
        relativePath: "types.ts",
        line: 1,
        body: "interface User {\n  name: string;\n  age: number;\n}",
      });
    },
  );

  it.each([
    ["incoming-calls", "callHierarchy/incomingCalls", "from"],
    ["outgoing-calls", "callHierarchy/outgoingCalls", "to"],
  ] as const)("routes %s through call hierarchy preparation", async (action, method, peerField) => {
    const path = file("peer.ts", "function peer() {}\n");
    const item = {
      name: "source",
      kind: 12,
      uri: pathToFileURL(position().path).href,
      range: range(),
    };
    backend.responses.set("textDocument/prepareCallHierarchy", [item]);
    backend.responses.set(method, [
      { [peerField]: { name: "peer", kind: 12, uri: pathToFileURL(path).href, range: range() } },
    ]);
    expect(result(await execute(request(action, position())), action)).toMatchObject({
      symbol: "source",
      total: 1,
      truncated: false,
      items: [
        {
          name: "peer",
          kind: "function",
          relativePath: "peer.ts",
          line: 1,
          content: "function peer() {}",
        },
      ],
    });
    expect(backend.requests[1]).toEqual({ method, params: { item } });
  });

  it("routes rename validation without invoking the backend", async () => {
    expect(await execute(request("rename", position()))).toEqual({
      id: 41,
      ok: false,
      error: "newName required for rename",
    });
    expect(backend.requests).toEqual([]);
  });

  it("returns references with source lines", async () => {
    const path = file("references.ts", "function greet() {}\ngreet();\n");
    backend.responses.set(
      "textDocument/references",
      [0, 1].map((line) => ({ uri: pathToFileURL(path).href, range: range(line) })),
    );
    const response = result(await execute(request("references", position())), "references");
    expect(response.total).toBe(2);
    expect(response.items.map(({ line, content }) => ({ line, content }))).toEqual([
      { line: 1, content: "function greet() {}" },
      { line: 2, content: "greet();" },
    ]);
  });

  it("returns empty items for no references", async () => {
    expect(result(await execute(request("references", position())), "references")).toMatchObject({
      total: 0,
      items: [],
      truncated: false,
    });
  });

  it.each([
    ["references", "textDocument/references"],
    ["symbols", "textDocument/documentSymbol"],
  ] as const)(
    "preserves %s request failures instead of returning empty results",
    async (action, method) => {
      const error = `typescript LSP request timed out: ${method}`;
      backend.failures.set(method, new Error(error));
      expect(await execute(request(action, position()))).toEqual({ id: 41, ok: false, error });
    },
  );

  it("returns document symbols with normalized kinds and lines", async () => {
    backend.responses.set("textDocument/documentSymbol", [
      { name: "Foo", kind: 11, range: range(), selectionRange: range() },
      { name: "bar", kind: 12, range: range(1), selectionRange: range(1) },
    ]);
    expect(result(await execute(request("symbols", position())), "symbols").items).toEqual([
      { name: "Foo", kind: "interface", line: 1 },
      { name: "bar", kind: "function", line: 2 },
    ]);
  });

  it("rejects workspace queries when no backend supports them", async () => {
    backend.supportsWorkspaceSymbols = false;
    expect(await execute(request("symbols", { query: "User" }))).toEqual({
      id: 41,
      ok: false,
      error: "No backends support workspace/symbol",
    });
    expect(backend.requests).toEqual([]);
  });

  it("rejects a cold workspace query before a project file opens", async () => {
    backend.projectRoots = [];
    expect(await execute(request("symbols", { query: "User" }))).toEqual({
      id: 41,
      ok: false,
      error: "Workspace symbols require an opened project file. Request document symbols first.",
    });
    expect(backend.requests).toEqual([]);
  });

  it("returns workspace symbols for a query", async () => {
    backend.responses.set("workspace/symbol", [
      {
        name: "User",
        kind: 11,
        location: { uri: pathToFileURL(join(root, "types.ts")).href, range: range() },
      },
    ]);
    expect(result(await execute(request("symbols", { query: "User" })), "symbols").items).toEqual([
      {
        name: "User",
        kind: "interface",
        line: 1,
        relativePath: "types.ts",
        absolutePath: join(root, "types.ts"),
      },
    ]);
  });

  it("rejects symbols without a path or query", async () => {
    expect(await execute(request("symbols"))).toEqual({
      id: 41,
      ok: false,
      error: "symbols requires either path or query",
    });
  });

  it("returns unmatched-backend errors and bounds unknown action dispatch", async () => {
    expect(await execute(request("symbols", { path: join(root, "unknown.xyz") }))).toEqual({
      id: 41,
      ok: false,
      error: `No language server configured for: ${join(root, "unknown.xyz")}`,
    });
    for (const action of ["not-an-action", "toString", "__proto__"]) {
      expect(await execute({ id: 42, action } as DaemonRequest)).toEqual({
        id: 42,
        ok: false,
        error: `Unknown action: ${action}`,
      });
    }
  });

  it("translates non-Error dispatch failures to the existing fallback", async () => {
    backend.failures.set("textDocument/references", "not an Error");
    expect(await execute(request("references", position()))).toEqual({
      id: 41,
      ok: false,
      error: "Unknown error",
    });
  });

  it("selects the first matching backend for files and only eligible backends for workspace queries", async () => {
    const bash = new ControlledBackend(join(root, "bash"), "bash", ".sh");
    const duplicate = new ControlledBackend(root);
    duplicate.supportsWorkspaceSymbols = false;
    const cold = new ControlledBackend(root, "cold", ".cold", []);
    const backends = [bash, backend, duplicate, cold];
    const run = createDaemonRequestExecutor({
      backends,
      fileCache: new FileCache(),
      getIdleMs: () => 0,
    });
    backend.responses.set("textDocument/hover", { contents: "TypeScript" });
    expect(result(await run(request("hover", position())), "hover").signature).toBe("TypeScript");
    bash.responses.set("workspace/symbol", [
      {
        name: "shell",
        kind: 12,
        location: { uri: pathToFileURL(join(bash.root, "script.sh")).href, range: range() },
      },
    ]);
    backend.responses.set("workspace/symbol", [
      {
        name: "typescript",
        kind: 12,
        location: { uri: pathToFileURL(position().path).href, range: range() },
      },
    ]);
    const response = result(await run(request("symbols", { query: "value" })), "symbols");
    expect(response.items.map(({ name, relativePath }) => ({ name, relativePath }))).toEqual([
      { name: "shell", relativePath: "script.sh" },
      { name: "typescript", relativePath: "source.ts" },
    ]);
    expect(duplicate.requests).toEqual([]);
    expect(cold.requests).toEqual([]);
  });
});
