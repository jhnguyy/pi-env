import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { activateNotesExtension } from "../index";
import {
  AgentToolEvent,
  PiEvent,
  ToolCapability,
  resetAgentToolRegistryForTests,
  type ExtToolRegistration,
} from "../../_shared/agent-tools";
import type { SettingsEnv } from "../../_shared/settings";

const roots: string[] = [];

afterEach(async () => {
  resetAgentToolRegistryForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function settingsEnv(document: unknown): SettingsEnv {
  return {
    globalSettingsPath: () => "/global/settings.json",
    projectSettingsPath: () => "/repo/.pi/settings.json",
    readFile: (filePath) => {
      if (filePath === "/global/settings.json") return JSON.stringify(document);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
}

function harness() {
  const tools: any[] = [];
  const registrations: ExtToolRegistration[] = [];
  const sessionHandlers: Array<(event: unknown, ctx: ExtensionContext) => void> = [];
  return {
    tools,
    registrations,
    pi: {
      registerTool(tool: any) {
        tools.push(tool);
      },
      events: {
        emit(event: typeof AgentToolEvent.Register, registration: ExtToolRegistration) {
          if (event === AgentToolEvent.Register) registrations.push(registration);
        },
      },
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
        if (event === PiEvent.SessionStart) sessionHandlers.push(handler);
      },
    },
    startSession() {
      for (const handler of sessionHandlers) {
        handler({ type: PiEvent.SessionStart, reason: "startup" }, {
          cwd: "/repo",
        } as ExtensionContext);
      }
    },
  };
}

describe("notes extension", () => {
  it("does not register a tool without notes settings", async () => {
    const testHarness = harness();

    await activateNotesExtension(testHarness.pi as any, "/repo", settingsEnv({}));

    expect(testHarness.tools).toEqual([]);
  });

  it("registers the configured Obsidian provider across Pi and AgentTool hosts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-notes-extension-"));
    roots.push(root);
    const vault = path.join(root, "vault");
    await mkdir(vault);
    const testHarness = harness();

    await activateNotesExtension(
      testHarness.pi as any,
      "/repo",
      settingsEnv({
        notes: { provider: "obsidian", vaultPath: vault },
      }),
    );
    testHarness.startSession();

    expect(testHarness.tools).toHaveLength(1);
    expect(testHarness.tools[0].name).toBe("notes");
    expect(testHarness.registrations).toHaveLength(1);
    expect(testHarness.registrations[0].tool.parameters).toBe(testHarness.tools[0].parameters);
    expect(testHarness.registrations[0].capabilities).toEqual([
      ToolCapability.Read,
      ToolCapability.Write,
    ]);
  });
});
