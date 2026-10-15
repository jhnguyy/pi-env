import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSubagentHarness } from "./harness";

it("registers the entire native available roster and descriptive tags despite restrictive cycling settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-roster-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("OTEL_SDK_DISABLED", "true");
  const harness = createSubagentHarness();
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
    expect(SettingsManager.create(cwd, agentDir).getEnabledModels()).toEqual(["roster/quick"]);
    await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const description = harness.tools.get("subagent").description;
    // Real native availability and real settings cross the extension-start registration boundary.
    for (const model of ctx.modelRegistry.getAvailable()) {
      expect(description).toContain(`${model.provider}/${model.id} — ${model.name}`);
    }
    expect(description).toContain("roster/quick — Quick [preferred, experimental]");
    expect(description).toContain("roster/deep — Deep [heavy, reviewer]");
    expect(description).toContain("roster/plain — Plain");
    expect(description).not.toContain("roster/unavailable");
    expect(description).not.toContain("[local]");
  } finally {
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
