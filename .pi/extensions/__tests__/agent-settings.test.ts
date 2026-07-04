import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  readAgentSettingsEffect,
  readOptionalAgentSettings,
  type AgentSettingsEnv,
} from "../_shared/agent-settings";

function envWith(content: string): AgentSettingsEnv {
  return {
    settingsPath: () => "/tmp/pi-settings.json",
    readFile: () => content,
  };
}

describe("agent settings", () => {
  it("parses shared settings blocks from settings.json", async () => {
    const settings = await Effect.runPromise(readAgentSettingsEffect(envWith(JSON.stringify({
      enabledModels: ["provider/model"],
      modelAnnotations: { "provider/model": ["preferred"] },
      workTracker: { repos: ["/repo"], protectedBranches: ["main"] },
    }))));

    expect(settings.enabledModels).toEqual(["provider/model"]);
    expect(settings.modelAnnotations).toEqual({ "provider/model": ["preferred"] });
    expect(settings.workTracker).toEqual({ repos: ["/repo"], protectedBranches: ["main"] });
  });

  it("keeps malformed or missing settings optional at extension call sites", () => {
    const malformed = readOptionalAgentSettings(envWith("not json"));
    const missing = readOptionalAgentSettings({
      settingsPath: () => "/tmp/missing-settings.json",
      readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    });

    expect(malformed).toBeNull();
    expect(missing).toBeNull();
  });

  it("reports the settings path on Effect failures", async () => {
    const result = await Effect.runPromise(Effect.either(readAgentSettingsEffect(envWith("not json"))));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.path).toBe("/tmp/pi-settings.json");
      expect(result.left._tag).toBe("AgentSettingsReadError");
    }
  });
});
