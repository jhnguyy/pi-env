import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as ChildContext from "../../_shared/child-context";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import * as Tooling from "../../../../src/telemetry/tooling";
import * as SessionRuntime from "../session-runtime";

// Native target configuration and inference boundary; no parent model catalog or loop injection.
it("runs native target configuration with explicit overrides through the public runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-configured-child-"));
  const spans: ReadableSpan[] = [];
  const runtime = new SessionRuntime.SubagentSessionRuntime({ appendEntry: () => {}, events: { emit: () => {} } } as any, {
    telemetryRuntimeFactory: () => Tooling.createToolingTelemetryRuntime({
      serviceName: "native-contract", env: { PI_ENV_TOOLING_OTEL_ENABLED: "true", PI_ENV_TOOLING_OTEL_ENDPOINT: "http://collector:4318" },
      exporter: { export: (finished, callback) => { spans.push(...finished); callback({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
    }),
  });
  try {
    mkdirSync(join(root, ".pi"), { recursive: true });
    const extension = join(root, ".pi", "provider.mjs");
    writeFileSync(extension, `import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
 const p = fauxProvider({provider:'configured'});
 p.setResponses([fauxAssistantMessage('configured answer')]);
 pi.registerProvider(p.provider);
}`);
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ extensions: [extension] }));
    const ctx: any = { cwd: root, sessionManager: SessionManager.create(root, join(root, "sessions")), isProjectTrusted: () => true };
    await ChildContext.withChildContext({ cwd: root, agentDir: join(root, "agent") }, async () => {
      await runtime.startSession(ctx);
      const params = { name: "configured", task: "private task", tools: [], model: "configured/faux-1", system_prompt: "Explicit delegated instruction" };
      const updates: string[] = [];
      const result = await runtime.execute("configured-run", params, undefined, update => updates.push(JSON.stringify(update.content)), ctx);
      expect(result.details.isError, JSON.stringify(result)).toBe(false);
      expect(result.details.finalOutput).toBe("configured answer");
      expect(updates.join("\n")).toContain("configured answer");
      expect(result.details.toolNames).toEqual([]);
      const reopened = SessionManager.open(result.details.sessionFile!);
      expect(reopened.buildSessionContext().messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "configured answer" }] }));
      expect(ctx.sessionManager.buildSessionContext().messages).toEqual([]);
      await runtime.shutdownSession();
      expect(spans.map(span => span.name)).toContain("tooling.subagent.run");
      const exported = JSON.stringify(spans.map(span => ({ name: span.name, attributes: span.attributes, events: span.events })));
      for (const secret of [root, "private task", "configured answer", "Explicit delegated instruction"]) expect(exported).not.toContain(secret);
    });
  } finally {
    await runtime.shutdownSession();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
