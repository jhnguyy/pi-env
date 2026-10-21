import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, resolveModelScopeWithDiagnostics, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import initSubagent from "../index";
function createHarness() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  initSubagent({
    getAllTools: () => [], appendEntry: () => {}, registerCommand: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => handlers.set(name, handler),
    events: { emit: () => {}, on: () => {} },
  } as any);
  return { tools, handlers };
}


it("advertises the native scoped roster with descriptive tags, or every available model without a scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-roster-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("OTEL_SDK_DISABLED", "true");
  const harness = createHarness();
  const ctx: any = { cwd, sessionManager: SessionManager.create(cwd, join(root, "sessions")) };
  try {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["roster/quick"] }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      modelAnnotations: { "roster/quick": ["preferred", "experimental"], "roster/deep": ["heavy", "reviewer"],
        "roster/unavailable": ["local"] },
    }));
    const faux = fauxProvider({ provider: "roster", models: [
      { id: "quick", name: "Quick" }, { id: "deep", name: "Deep" }, { id: "plain", name: "Plain" },
    ] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.getAvailable();
    ctx.modelRegistry = new ModelRegistry(runtime);
    const enabledModels = SettingsManager.create(cwd, agentDir).getEnabledModels()!;
    // Native scope resolution stands in for the session's --models/enabledModels snapshot.
    ctx.scopedModels = (await resolveModelScopeWithDiagnostics(enabledModels, runtime)).scopedModels;
    await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const scoped = harness.tools.get("subagent").description;
    expect(scoped).toContain("Parent scoped models");
    expect(scoped).toContain("roster/quick [preferred, experimental]");
    expect(scoped).toContain("Other available models also work.");
    expect(scoped).not.toContain("roster/deep");
    expect(scoped).not.toContain("roster/plain");
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);

    ctx.scopedModels = [];
    await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const unscoped = harness.tools.get("subagent").description;
    expect(unscoped).toContain("Parent available models");
    expect(unscoped).toContain("roster/deep [heavy, reviewer]");
    expect(unscoped).toContain("roster/plain");
    expect(unscoped).not.toContain("Other available models");
    expect(unscoped).not.toContain("roster/unavailable");
    expect(unscoped).not.toContain("[local]");
  } finally {
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
