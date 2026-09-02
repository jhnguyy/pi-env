import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { activateNotesExtension, NotesProviderEvent } from "../index";
import type { NotesProvider } from "../domain";
import { resetNotesProviderRegistryForTests, resolveNotesProvider } from "../provider-registry";
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
  resetNotesProviderRegistryForTests();
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
  const shutdownHandlers: Array<(event: unknown, ctx: ExtensionContext) => void> = [];
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    tools,
    registrations,
    pi: {
      registerTool(tool: any) {
        tools.push(tool);
      },
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
          return () => {
            eventHandlers.set(
              event,
              (eventHandlers.get(event) ?? []).filter((candidate) => candidate !== handler),
            );
          };
        },
        emit(event: string, payload: unknown) {
          if (event === AgentToolEvent.Register) registrations.push(payload as ExtToolRegistration);
          for (const handler of eventHandlers.get(event) ?? []) handler(payload);
        },
      },
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
        if (event === PiEvent.SessionStart) sessionHandlers.push(handler);
        if (event === PiEvent.SessionShutdown) shutdownHandlers.push(handler);
      },
    },
    startSession() {
      for (const handler of sessionHandlers) {
        handler({ type: PiEvent.SessionStart, reason: "startup" }, {
          cwd: "/repo",
        } as ExtensionContext);
      }
    },
    shutdownSession() {
      for (const handler of shutdownHandlers) {
        handler({ type: PiEvent.SessionShutdown, reason: "reload" }, {
          cwd: "/repo",
        } as ExtensionContext);
      }
    },
  };
}

function externalProvider(id: string, indexText: string): NotesProvider {
  return {
    id,
    index: async () => ({ text: indexText }),
    list: async () => [],
    read: async (notePath) => ({ path: notePath, content: "", revision: "revision" }),
    search: async () => [],
    write: async (request) => ({ path: request.path, revision: "next" }),
    delete: async (request) => ({ path: request.path }),
  };
}

describe("notes extension", () => {
  it("does not register a tool without notes settings", async () => {
    const testHarness = harness();

    await activateNotesExtension(testHarness.pi as any, "/repo", settingsEnv({}));

    expect(testHarness.tools).toEqual([]);
  });

  it("resolves an external provider lazily regardless of extension load order", async () => {
    const testHarness = harness();
    await activateNotesExtension(
      testHarness.pi as any,
      "/repo",
      settingsEnv({ notes: { provider: "notes-assistant" } }),
    );
    const tool = testHarness.tools[0];
    await expect(
      tool.execute("call", { action: "list" }, undefined, undefined, { cwd: "/repo" }),
    ).rejects.toThrow("not registered");
    const external: NotesProvider = {
      id: "notes-assistant",
      index: async () => ({ text: "Remote store conventions" }),
      list: async () => [{ path: "remote/notes.md" }],
      read: async (notePath) => ({ path: notePath, content: "", revision: "revision" }),
      search: async () => [],
      resolve: async () => ({ path: "today.md", content: "", revision: "revision" }),
      write: async (request) => ({ path: request.path, revision: "next" }),
      delete: async (request) => ({ path: request.path }),
    };
    testHarness.pi.events.emit(NotesProviderEvent.Register, { provider: external });
    await expect(
      tool.execute("call", { action: "list" }, undefined, undefined, { cwd: "/repo" }),
    ).resolves.toMatchObject({
      details: { notes: [{ path: "remote/notes.md" }] },
    });
  });

  it("discovers an independently bundled provider that loads first", async () => {
    const testHarness = harness();
    const external: NotesProvider = {
      id: "notes-assistant",
      index: async () => ({ text: "Remote store conventions" }),
      list: async () => [],
      read: async (notePath) => ({ path: notePath, content: "", revision: "revision" }),
      search: async () => [],
      write: async (request) => ({ path: request.path, revision: "next" }),
      delete: async (request) => ({ path: request.path }),
    };
    testHarness.pi.events.on(NotesProviderEvent.Discover, () => {
      testHarness.pi.events.emit(NotesProviderEvent.Register, { provider: external });
    });

    await activateNotesExtension(
      testHarness.pi as any,
      "/repo",
      settingsEnv({ notes: { provider: "notes-assistant" } }),
    );

    await expect(
      testHarness.tools[0].execute("call", { action: "index" }, undefined, undefined, {
        cwd: "/repo",
      }),
    ).resolves.toMatchObject({
      content: [{ text: "Remote store conventions" }],
    });
  });
  it("replaces reloaded event providers and removes the bridge on shutdown", async () => {
    const testHarness = harness();
    await activateNotesExtension(
      testHarness.pi as any,
      "/repo",
      settingsEnv({ notes: { provider: "notes-assistant" } }),
    );
    const first = externalProvider("notes-assistant", "first");
    const second = externalProvider("notes-assistant", "second");

    expect(() => testHarness.pi.events.emit(NotesProviderEvent.Register, {})).not.toThrow();
    testHarness.pi.events.emit(NotesProviderEvent.Register, { provider: first });
    testHarness.pi.events.emit(NotesProviderEvent.Register, { provider: second });
    expect(resolveNotesProvider("notes-assistant")).toBe(second);

    testHarness.shutdownSession();
    expect(() => resolveNotesProvider("notes-assistant")).toThrow("not registered");
    testHarness.pi.events.emit(NotesProviderEvent.Register, { provider: first });
    expect(() => resolveNotesProvider("notes-assistant")).toThrow("not registered");
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
    expect(testHarness.tools[0].promptGuidelines).toContainEqual(
      expect.stringContaining("provider-owned conventions"),
    );
    expect(testHarness.tools[0].promptGuidelines).toContainEqual(
      expect.stringContaining("coherent rewrite"),
    );
    expect(testHarness.tools[0].promptGuidelines).toContainEqual(
      expect.stringContaining("secrets"),
    );
    expect(testHarness.registrations).toHaveLength(1);
    expect(testHarness.registrations[0].tool.parameters).toBe(testHarness.tools[0].parameters);
    expect(testHarness.registrations[0].capabilities).toEqual([
      ToolCapability.Read,
      ToolCapability.Write,
    ]);
    await expect(
      testHarness.tools[0].execute("call", { action: "index" }, undefined, undefined, {
        cwd: "/repo",
      }),
    ).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("provider:obsidian") }],
    });
  });
});
