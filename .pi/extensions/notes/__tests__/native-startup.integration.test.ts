import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { activateNotesExtension } from "../index";

// Only inference is scripted. Resource loading, native tool dispatch, session files, and vaults
// are real. The native provider extension is loaded separately for each owner.
it("keeps simultaneous native owners' configured vaults independent through shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-notes-owners-"));
  const sessions: AgentSession[] = [];
  const closed = new Set<AgentSession>();
  const close = async (session: AgentSession) => {
    if (closed.has(session)) return;
    closed.add(session);
    await session.abort();
    try {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  };
  try {
    const create = async (name: string) => {
      const cwd = join(root, name);
      const agentDir = join(cwd, "agent");
      const vault = join(cwd, "vault");
      await mkdir(agentDir, { recursive: true });
      await mkdir(vault);
      await writeFile(join(vault, "identity.md"), name);
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          notes: { provider: "obsidian", vaultPath: vault },
        }),
      );
      const provider = fauxProvider({ provider: `notes-${name}` });
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
        resourceLoaderOptions: {
          extensionFactories: [
            {
              name: "test-provider",
              factory: (pi) => {
                pi.registerProvider(provider.provider);
              },
            },
            {
              name: "notes",
              factory: (pi) =>
                activateNotesExtension(pi, cwd, {
                  globalSettingsPath: () => join(agentDir, "settings.json"),
                  projectSettingsPath: () => join(cwd, ".pi", "settings.json"),
                  readFile: readFileSync,
                }),
            },
          ],
        },
      });
      expect(services.diagnostics.filter((item) => item.type === "error")).toEqual([]);
      const { session, extensionsResult } = await createAgentSessionFromServices({
        services,
        model: provider.getModel(),
        sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
        tools: ["notes"],
      });
      sessions.push(session);
      expect(extensionsResult.errors).toEqual([]);
      await session.bindExtensions({ mode: "print" });
      return { session, provider };
    };
    const first = await create("first");
    const second = await create("second");
    const read = async ({ session, provider }: Awaited<ReturnType<typeof create>>) => {
      const start = session.messages.length;
      provider.setResponses([
        fauxAssistantMessage(fauxToolCall("notes", { action: "read", path: "identity.md" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("read complete"),
      ]);
      await session.prompt("Read identity.md using notes.");
      await session.waitForIdle();
      const result = session.messages.slice(start).find((message) => message.role === "toolResult");
      expect(result).toBeDefined();
      expect(result).toMatchObject({ isError: false });
      return result;
    };
    expect(await read(first)).toMatchObject({
      content: [{ text: expect.stringContaining("first") }],
    });
    expect(await read(second)).toMatchObject({
      content: [{ text: expect.stringContaining("second") }],
    });
    await close(first.session);
    expect(await read(second)).toMatchObject({
      content: [{ text: expect.stringContaining("second") }],
    });
    for (const { session } of [first, second]) {
      const reopened = SessionManager.open(session.sessionManager.getSessionFile()!);
      expect(reopened.buildSessionContext().messages).toEqual(session.messages);
    }
  } finally {
    for (const session of sessions) await close(session);
    await rm(root, { recursive: true, force: true });
  }
});
