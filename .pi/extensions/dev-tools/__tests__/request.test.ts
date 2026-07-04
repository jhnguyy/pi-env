import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { buildClientRequest, DevToolsAction } from "../request";

describeIfEnabled("dev-tools", "request builder", () => {
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

  it("rejects multi-path requests for single-path actions", () => {
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
