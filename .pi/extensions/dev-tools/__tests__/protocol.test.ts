import { describe, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  serializeRequest,
  serializeResponse,
  parseRequest,
  parseResponse,
  type DaemonRequest,
  type DaemonResponse,
  type DiagnosticsResult,
} from "../protocol";

describeIfEnabled("dev-tools", "Protocol", () => {
  // ─── serializeRequest ───────────────────────────────────────────────────

  describe("serializeRequest", () => {
    it("round-trips one newline-delimited request", () => {
      const req: DaemonRequest = { id: 1, action: "diagnostics", path: "/foo/bar.ts" };
      const encoded = serializeRequest(req);

      expect(encoded.endsWith("\n")).toBe(true);
      expect(parseRequest(encoded)).toEqual(req);
    });
  });

  // ─── parseRequest ────────────────────────────────────────────────────────

  describe("parseRequest", () => {
    it("handles line without trailing newline", () => {
      const req: DaemonRequest = { id: 3, action: "symbols", query: "User" };
      const line = JSON.stringify(req);
      expect(parseRequest(line)).toEqual(req);
    });

    it.each(["", "  ", "{not valid json}"])("rejects invalid input", (line) => {
      expect(() => parseRequest(line)).toThrow();
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
});
