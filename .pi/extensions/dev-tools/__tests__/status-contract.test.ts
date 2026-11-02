import { describe, expect, it } from "vitest";
import { formatStatus } from "../formatters";
import type { StatusResult } from "../protocol";

describe("status contract", () => {
  it("formats a ready snapshot with semantic availability and zero request items", () => {
    const result: StatusResult = {
      action: "status",
      state: "ready",
      running: true,
      pid: 123,
      backend: {
        name: "typescript",
        running: true,
      },
      project: {
        mode: "configured",
        root: "/repo",
        tsconfigPath: "/repo/tsconfig.json",
      },
      initialization: {
        state: "initialized",
      },
      semantic: {
        available: true,
        lastRequest: {
          method: "textDocument/references",
          itemCount: 0,
        },
      },
      projects: ["/repo"],
      openFiles: [],
      watchedFiles: 0,
      idleMs: 50,
    };

    expect(formatStatus(result)).toBe(
      [
        "state: ready",
        "daemon: running",
        "pid: 123",
        "backend: typescript running",
        "project mode: configured",
        "project root: /repo",
        "tsconfig: /repo/tsconfig.json",
        "initialization: initialized",
        "semantic: available",
        "last semantic request: textDocument/references (0 items)",
        "projects: /repo",
        "open files: none",
        "idle: 0s",
      ].join("\n"),
    );
  });

  it("formats an initializing snapshot with a running backend and unavailable semantics", () => {
    const result: StatusResult = {
      action: "status",
      state: "initializing",
      running: true,
      pid: 456,
      backend: {
        name: "typescript",
        running: true,
      },
      project: {
        mode: "inferred",
        root: "/repo",
      },
      initialization: {
        state: "initializing",
      },
      semantic: {
        available: false,
      },
      projects: ["/repo"],
      openFiles: [],
      watchedFiles: 0,
      idleMs: 0,
    };

    expect(formatStatus(result)).toBe(
      [
        "state: initializing",
        "daemon: running",
        "pid: 456",
        "backend: typescript running",
        "project mode: inferred",
        "project root: /repo",
        "initialization: initializing",
        "semantic: unavailable",
        "projects: /repo",
        "open files: none",
        "idle: 0s",
      ].join("\n"),
    );
  });

  it("formats a degraded snapshot with project, request, and semantic failure fields", () => {
    const result: StatusResult = {
      action: "status",
      state: "degraded",
      running: true,
      pid: 789,
      backend: {
        name: "typescript",
        running: true,
        stderrTail: "first line\nsecond   line",
      },
      project: {
        mode: "configured",
        root: "/repo",
        tsconfigPath: "/repo/tsconfig.json",
      },
      initialization: {
        state: "initialized",
      },
      semantic: {
        available: false,
        lastRequest: {
          method: "textDocument/definition",
          itemCount: 0,
        },
        semanticFailure: {
          method: "textDocument/hover",
          detail: "typescript LSP hover request timed out",
        },
      },
      projects: ["/repo"],
      openFiles: ["/repo/src/index.ts"],
      watchedFiles: 1,
      idleMs: 100,
    };

    expect(formatStatus(result)).toBe(
      [
        "state: degraded",
        "daemon: running",
        "pid: 789",
        "backend: typescript running",
        "project mode: configured",
        "project root: /repo",
        "tsconfig: /repo/tsconfig.json",
        "initialization: initialized",
        "semantic: unavailable",
        "last semantic request: textDocument/definition (0 items)",
        "semantic failure: textDocument/hover: typescript LSP hover request timed out",
        "stderr: first line second line",
        "projects: /repo",
        "open files: 1",
        "idle: 0s",
      ].join("\n"),
    );
  });

  it("formats a failed snapshot with separate daemon/backend liveness and bounded failure detail", () => {
    const result: StatusResult = {
      action: "status",
      state: "failed",
      running: false,
      backend: {
        name: "typescript",
        running: false,
        startupFailure: "spawn   ENOENT\n" + "x".repeat(300),
      },
      project: {
        mode: "unknown",
      },
      initialization: {
        state: "failed",
      },
      semantic: {
        available: false,
      },
      projects: [],
      openFiles: [],
      watchedFiles: 0,
      idleMs: 0,
    };

    const text = formatStatus(result);
    const failureLine = text.split("\n").find((line) => line.startsWith("startup failure: "));
    expect(failureLine).toBeDefined();
    const detail = failureLine!.replace("startup failure: ", "");
    expect(detail).toMatch(/^spawn ENOENT x+\.\.\.$/);
    expect(detail).not.toMatch(/[\r\n\t]| {2}/);
    expect(detail.length).toBeLessThanOrEqual(256);
    expect(text).not.toContain("spawn   ENOENT");
    expect(text.split("\n").filter((line) => line !== failureLine)).toEqual([
      "state: failed",
      "daemon: stopped",
      "backend: typescript stopped",
      "project mode: unknown",
      "initialization: failed",
      "semantic: unavailable",
      "projects: none",
      "open files: none",
      "idle: 0s",
    ]);
  });
});
