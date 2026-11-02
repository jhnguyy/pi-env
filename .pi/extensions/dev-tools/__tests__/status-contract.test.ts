import { describe, expect, it } from "vitest";
import { formatStatus } from "../formatters";
import type { StatusResult } from "../protocol";

describe("status contract", () => {
  it("formats ready and initializing branches without inventing optional request or config fields", () => {
    const result: StatusResult = {
      action: "status",
      state: "initializing",
      running: true,
      backend: { name: "bash", running: false },
      project: { mode: "inferred", root: "/scripts" },
      initialization: { state: "initializing" },
      semantic: { available: false },
      projects: [],
      openFiles: [],
      watchedFiles: 0,
      idleMs: 0,
    };
    const initializing = formatStatus(result);
    for (const line of [
      "state: initializing",
      "daemon: running",
      "backend: bash stopped",
      "project mode: inferred",
      "project root: /scripts",
      "initialization: initializing",
      "semantic: unavailable",
    ]) {
      expect(initializing.split("\n")).toContain(line);
    }
    expect(initializing).not.toMatch(/last semantic request:|tsconfig:|pid:/);

    const ready = formatStatus({
      ...result,
      state: "ready",
      backend: { name: "bash", running: true },
      initialization: { state: "initialized" },
      semantic: {
        available: true,
        lastRequest: { method: "textDocument/references", itemCount: 0 },
      },
    });
    for (const line of [
      "state: ready",
      "backend: bash running",
      "initialization: initialized",
      "semantic: available",
      "last semantic request: textDocument/references (0 items)",
    ]) {
      expect(ready.split("\n")).toContain(line);
    }
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
