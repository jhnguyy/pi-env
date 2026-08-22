import { describe, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { formatStatus } from "../formatters";
import type { StatusResult } from "../protocol";

const MAX_STATUS_DETAIL_LENGTH = 256;

type ExpectedStatusContract = {
  action: "status";
  state: "ready" | "initializing" | "degraded" | "failed";
  running: boolean;
  pid?: number;
  backend: {
    name: string;
    running: boolean;
    stderrTail?: string;
    startupFailure?: string;
  };
  project: {
    mode: "configured" | "inferred" | "unknown";
    root?: string;
    tsconfigPath?: string;
  };
  initialization: {
    state: "initializing" | "initialized" | "failed";
  };
  semantic: {
    available: boolean;
    lastRequest?: {
      method: string;
      itemCount: number;
    };
  };
  projects: string[];
  openFiles: string[];
  watchedFiles: number;
  idleMs: number;
};

function formatExpectedStatus(result: ExpectedStatusContract): string {
  return formatStatus(result);
}

describeIfEnabled("dev-tools", "status contract", () => {
  it("defines ready as semantic readiness and preserves a valid empty semantic result", () => {
    const result: ExpectedStatusContract = {
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

    expect(formatExpectedStatus(result)).toBe([
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
    ].join("\n"));
  });

  it("defines initializing as process-live but not semantically ready", () => {
    const result: ExpectedStatusContract = {
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

    expect(formatExpectedStatus(result)).toBe([
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
    ].join("\n"));
  });

  it("defines degraded as process-live but semantically unavailable while retaining required project and semantic request fields", () => {
    const result: ExpectedStatusContract = {
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
      },
      projects: ["/repo"],
      openFiles: ["/repo/src/index.ts"],
      watchedFiles: 1,
      idleMs: 100,
    };

    expect(formatExpectedStatus(result)).toBe([
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
      "stderr: first line second line",
      "projects: /repo",
      "open files: 1",
      "idle: 0s",
    ].join("\n"));
  });

  it("defines failed independently from process liveness and bounds normalized failure detail", () => {
    const result: ExpectedStatusContract = {
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

    const text = formatExpectedStatus(result);
    expect(text).toBe([
      "state: failed",
      "daemon: stopped",
      "backend: typescript stopped",
      "project mode: unknown",
      "initialization: failed",
      "semantic: unavailable",
      `startup failure: ${("spawn ENOENT " + "x".repeat(300)).slice(0, MAX_STATUS_DETAIL_LENGTH - 3)}...`,
      "projects: none",
      "open files: none",
      "idle: 0s",
    ].join("\n"));
    expect(text).not.toContain("spawn   ENOENT");
    const detail = text.split("startup failure: ")[1]?.split("\n")[0] ?? "";
    expect(detail).toHaveLength(MAX_STATUS_DETAIL_LENGTH);
  });
});
