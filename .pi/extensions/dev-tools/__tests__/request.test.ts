import { Result } from "effect";
import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { buildClientRequest, buildClientRequestResult, DevToolsAction } from "../request";

describeIfEnabled("dev-tools", "request builder", () => {
  const positionActions = [
    DevToolsAction.Hover,
    DevToolsAction.Definition,
    DevToolsAction.Implementation,
    DevToolsAction.References,
    DevToolsAction.IncomingCalls,
    DevToolsAction.OutgoingCalls,
  ] as const;

  function failureMessage(params: Parameters<typeof buildClientRequestResult>[0]): string | undefined {
    const result = buildClientRequestResult(params);
    return Result.isFailure(result) ? result.failure.message : undefined;
  }

  it("keeps diagnostics paths as a bulk request", () => {
    expect(buildClientRequest({
      action: DevToolsAction.Diagnostics,
      path: ["/repo/a.ts", "/repo/b.ts"],
    })).toEqual({
      action: "diagnostics",
      paths: ["/repo/a.ts", "/repo/b.ts"],
    });
  });

  it("normalizes a diagnostics string path to a one-item bulk request", () => {
    expect(buildClientRequest({ action: DevToolsAction.Diagnostics, path: "/repo/a.ts" })).toEqual({
      action: "diagnostics",
      paths: ["/repo/a.ts"],
    });
  });

  it("builds workspace and document symbols requests", () => {
    expect(buildClientRequest({ action: DevToolsAction.Symbols, query: "User" })).toEqual({
      action: "symbols",
      path: undefined,
      query: "User",
    });

    expect(buildClientRequest({ action: DevToolsAction.Symbols, path: "/repo/a.ts" })).toEqual({
      action: "symbols",
      path: "/repo/a.ts",
      query: undefined,
    });
  });

  it("passes line and character only to single-position actions", () => {
    expect(buildClientRequest({
      action: DevToolsAction.Definition,
      path: "/repo/a.ts",
      line: 3,
      character: 14,
    })).toEqual({
      action: "definition",
      path: "/repo/a.ts",
      line: 3,
      character: 14,
    });
  });

  it("rejects missing paths before daemon work", () => {
    expect(failureMessage({ action: DevToolsAction.Diagnostics })).toBe("diagnostics requires a path");

    for (const action of positionActions) {
      const params = { action, line: 1, character: 1 };
      expect(failureMessage(params)).toBe(`${action} requires a path`);
      expect(() => buildClientRequest(params)).toThrow(`${action} requires a path`);
    }
  });

  it("rejects incomplete positions before daemon work", () => {
    for (const action of positionActions) {
      expect(failureMessage({ action, path: "/repo/a.ts", character: 1 })).toBe(`${action} requires line and character`);
      expect(failureMessage({ action, path: "/repo/a.ts", line: 1 })).toBe(`${action} requires line and character`);
    }
  });

  it("requires a path or query for symbols", () => {
    expect(failureMessage({ action: DevToolsAction.Symbols })).toBe("symbols requires a path or query");
    expect(failureMessage({ action: DevToolsAction.Symbols, query: "   " })).toBe("symbols requires a path or query");
  });

  it("rejects multi-path requests for single-path actions", () => {
    const result = buildClientRequestResult({
      action: DevToolsAction.References,
      path: ["/repo/a.ts", "/repo/b.ts"],
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) ? result.failure : null).toEqual({
      _tag: "RequestBuildError",
      message: "references requires a single path — 2 were provided",
    });
    expect(() => buildClientRequest({
      action: DevToolsAction.References,
      path: ["/repo/a.ts", "/repo/b.ts"],
    })).toThrow("references requires a single path — 2 were provided");

    expect(() => buildClientRequest({
      action: DevToolsAction.Symbols,
      path: ["/repo/a.ts", "/repo/b.ts"],
    })).toThrow("symbols requires a single path — 2 were provided");
  });

  it("ignores path data for status", () => {
    expect(buildClientRequest({ action: DevToolsAction.Status, path: "/repo/a.ts" })).toEqual({
      action: "status",
    });
  });
});
