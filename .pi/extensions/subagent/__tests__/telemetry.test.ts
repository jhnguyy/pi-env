import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as Execute from "../execute";

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

// Resolution failures need no provider and still must not export private inputs.
// Successful native resource ownership is exercised by session-runtime-telemetry-lifecycle.
describe("subagent tooling telemetry privacy", () => {
  it("does not export task or workspace secrets, and honors disabled telemetry", async () => {
    const root = mkdtempSync(join(tmpdir(), "private-workspace-"));
    try {
      for (const enabled of [true, false]) {
        const finished: ReadableSpan[] = [];
        const result = await Effect.runPromise(Execute.runSubagentEffect(
          { name: "private-name", task: "private-task", cwd: "relative-private-path" },
          { cwd: root, sessionManager: SessionManager.inMemory(root) } as any,
          { env: enabled ? { PI_ENV_TOOLING_OTEL_ENABLED: "true", PI_ENV_TOOLING_OTEL_ENDPOINT: "http://collector:4318" } : {}, telemetryExporter: inMemoryExporter(finished) },
        ));
        expect(result.details.isError).toBe(true);
        if (!enabled) expect(finished).toEqual([]);
        const exported = JSON.stringify(finished.map(span => ({ name: span.name, attributes: span.attributes, events: span.events })));
        for (const secret of [root, "private-name", "private-task", "relative-private-path"]) expect(exported).not.toContain(secret);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
