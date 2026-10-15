import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createSubagentHarness } from "./harness";

// Only inference is scripted: native fauxProvider's documented response factory observes the
// provider transcript. ModelRuntime/ModelRegistry, public run, loop and persistence remain real.
it("runs a registered child through the configured native provider and reopens its exact transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-configured-child-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("OTEL_SDK_DISABLED", "true");
  const harness = createSubagentHarness();
  const ctx: any = { cwd: root, sessionManager: SessionManager.create(root, join(root, "sessions")) };
  try {
    const requests: TranscriptContext[] = [];
    const faux = fauxProvider({ provider: "configured", models: [{ id: "local" }] });
    faux.setResponses([(context) => {
      requests.push(context);
      return fauxAssistantMessage("configured answer");
    }]);
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.getAvailable();
    ctx.modelRegistry = new ModelRegistry(runtime);
    await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const result = await harness.tools.get("subagent").execute("configured-run", {
      action: "run", name: "configured", task: "task", tools: ["read"], model: "configured/local",
      system_prompt: "exact initial prompt\n",
    }, undefined, undefined, ctx);
    expect(result.details.isError).toBe(false);
    expect(result.details.finalOutput).toBe("configured answer");
    expect(requests.some((request) => request.messages.some((message) =>
      message.role === "system" && message.content === "exact initial prompt\n"))).toBe(true);
    expect(requests.some((request) => getCurrentTools(request.messages).some((tool) => tool.name === "read"))).toBe(true);
    const reopened = SessionManager.open(result.details.sessionFile);
    const messages = reopened.buildSessionContext().messages;
    expect(messages.filter((message) => message.role === "system" && message.content === "exact initial prompt\n")).toHaveLength(1);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "configured answer" }] }),
    ]));
  } finally {
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
