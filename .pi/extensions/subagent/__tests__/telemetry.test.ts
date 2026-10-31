import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as Execute from "../execute";
import * as Tooling from "../../../../src/telemetry/tooling";
import { Type } from "typebox";

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

// Boundary rejection needs no service or provider. Trace the supported parent
// runtime, not an exporter transported into a native child.
describe("subagent tooling telemetry privacy", () => {
  it("does not export task or workspace secrets, and honors disabled telemetry", async () => {
    const root = mkdtempSync(join(tmpdir(), "private-workspace-"));
    try {
      for (const enabled of [true, false]) {
        const finished: ReadableSpan[] = [];
        const runtime = await Effect.runPromise(Tooling.createToolingTelemetryRuntime({
          serviceName: Execute.SUBAGENT_TELEMETRY_SERVICE_NAME,
          env: enabled ? { PI_ENV_TOOLING_OTEL_ENABLED: "true", PI_ENV_TOOLING_OTEL_ENDPOINT: "http://collector:4318" } : {},
          exporter: inMemoryExporter(finished),
        }));
        try {
          await expect(Effect.runPromise(Execute.runResolvedSubagentEffect(
            {
              name: "private-name", task: "private-task", cwd: root,
              systemPrompt: "private-system-prompt",
              customTools: [{ name: "private-tool", label: "Private", description: "Private", parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } }],
            },
            { cwd: root, sessionManager: SessionManager.inMemory(root), isProjectTrusted: () => true },
            { telemetryRuntime: runtime },
          ))).rejects.toThrow("Executable private tools cannot cross the service boundary");
        } finally { await Effect.runPromise(runtime.disposeEffect); }
        if (enabled) expect(finished.map(span => span.name)).toContain("tooling.subagent.run");
        else expect(finished).toEqual([]);
        const exported = JSON.stringify(finished.map(span => ({ name: span.name, attributes: span.attributes, events: span.events })));
        for (const secret of [root, "private-name", "private-task", "private-system-prompt", "private-tool"]) expect(exported).not.toContain(secret);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
