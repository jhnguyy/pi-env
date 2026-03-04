import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  serializeRequest,
  serializeResponse,
  parseRequest,
  parseResponse,
  errorResponse,
  okResponse,
  type DaemonRequest,
  type DaemonResponse,
  type DiagnosticsResult,
} from "../protocol";

describeIfEnabled("lsp", "Protocol", () => {
  // ─── serializeRequest ───────────────────────────────────────────────────

  describe("serializeRequest", () => {
    it("serializes to JSON with trailing newline", () => {
      const req: DaemonRequest = { id: 1, action: "diagnostics", path: "/foo/bar.ts" };
      const out = serializeRequest(req);
      expect(out.endsWith("\n")).toBe(true);
      expect(JSON.parse(out.trim())).toEqual(req);
    });

    it("includes only defined fields", () => {
      const req: DaemonRequest = { id: 2, action: "hover", path: "/a.ts", line: 5, character: 10 };
      const out = serializeRequest(req);
      const parsed = JSON.parse(out.trim());
      expect(parsed.line).toBe(5);
      expect(parsed.character).toBe(10);
      expect(parsed.query).toBeUndefined();
    });
  });

  // ─── parseRequest ────────────────────────────────────────────────────────

  describe("parseRequest", () => {
    it("parses a valid request line", () => {
      const req: DaemonRequest = { id: 1, action: "diagnostics", path: "/foo.ts" };
      const line = JSON.stringify(req) + "\n";
      expect(parseRequest(line)).toEqual(req);
    });

    it("handles line without trailing newline", () => {
      const req: DaemonRequest = { id: 3, action: "symbols", query: "User" };
      const line = JSON.stringify(req);
      expect(parseRequest(line)).toEqual(req);
    });

    it("throws on empty line", () => {
      expect(() => parseRequest("")).toThrow();
      expect(() => parseRequest("  ")).toThrow();
    });

    it("throws on invalid JSON", () => {
      expect(() => parseRequest("{not valid json}")).toThrow();
    });
  });

  // ─── serializeResponse / parseResponse ──────────────────────────────────

  describe("serializeResponse / parseResponse", () => {
    it("round-trips an ok response", () => {
      const result: DiagnosticsResult = {
        action: "diagnostics",
        path: "/a.ts",
        errorCount: 2,
        warnCount: 0,
        items: [
          { line: 5, character: 3, severity: "error", code: "TS2339", message: "Property 'x' does not exist on type 'Y'." },
        ],
      };
      const res: DaemonResponse = { id: 7, ok: true, result };
      const line = serializeResponse(res);
      expect(parseResponse(line)).toEqual(res);
    });

    it("round-trips an error response", () => {
      const res: DaemonResponse = { id: 8, ok: false, error: "File not found" };
      const line = serializeResponse(res);
      expect(parseResponse(line)).toEqual(res);
    });

    it("parseResponse throws on empty line", () => {
      expect(() => parseResponse("")).toThrow();
    });
  });

  // ─── errorResponse / okResponse ─────────────────────────────────────────

  describe("errorResponse", () => {
    it("creates error response with correct shape", () => {
      const res = errorResponse(42, "something went wrong");
      expect(res).toEqual({ id: 42, ok: false, error: "something went wrong" });
    });
  });

  describe("okResponse", () => {
    it("creates success response with correct shape", () => {
      const result: DiagnosticsResult = {
        action: "diagnostics",
        path: "/b.ts",
        errorCount: 0,
        warnCount: 0,
        items: [],
      };
      const res = okResponse(10, result);
      expect(res).toEqual({ id: 10, ok: true, result });
    });
  });
});
