import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import * as TempDir from "../../../../src/testing/temp-dir";

it("loads the built get-only extension and natively discovers and expands the review skill", async () => {
  const root = await TempDir.forTest("native-review-context-");
  const agentDir = join(root, "agent");
  let session: AgentSession | undefined;
  const failures: unknown[] = [];
  try {
    await mkdir(agentDir);
    const provider = fauxProvider({ provider: "review-context-fixture" });
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalExtensionPaths: [resolve(".pi/extensions/review/dist/index.js")],
        additionalSkillPaths: [resolve(".agents/skills/review")],
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [
          (pi) => {
            pi.registerProvider(provider.provider);
          },
        ],
      },
    });
    expect(services.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
    const skills = services.resourceLoader.getSkills();
    expect(skills.diagnostics).toEqual([]);
    expect(skills.skills.map((skill) => skill.name)).toEqual(["review"]);
    const created = await createAgentSessionFromServices({
      services,
      model: provider.getModel(),
      tools: ["review"],
      sessionManager: SessionManager.inMemory(root),
    });
    session = created.session;
    expect(created.extensionsResult.errors).toEqual([]);
    const extension = created.extensionsResult.extensions.find((entry) =>
      entry.tools.has("review"),
    )!;
    expect(extension).toBeDefined();
    expect(extension.handlers.size).toBe(0);
    expect([...extension.commands.keys()]).toEqual(["review"]);
    expect(session.getActiveToolNames()).toEqual(["review"]);
    await session.bindExtensions({ mode: "print" });
    provider.setResponses([fauxAssistantMessage("Skill expansion received")]);
    await session.prompt("/skill:review inspect this supplied diff");
    await session.waitForIdle();
    const user = session.messages.find((message) => message.role === "user");
    expect(user).toMatchObject({
      content: expect.arrayContaining([
        { type: "text", text: expect.stringContaining('<skill name="review"') },
      ]),
    });
    expect(user).toMatchObject({
      content: expect.arrayContaining([
        { type: "text", text: expect.stringContaining("inspect this supplied diff") },
      ]),
    });
    // Invalid input exercises native schema/dispatch without GitHub access.
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("review", { command: "pr", action: "create" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("review", { command: "pr", action: "get", url: "invalid" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Validation complete"),
    ]);
    await session.prompt("Exercise invalid inputs only.");
    await session.waitForIdle();
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.isError)).toBe(true);
    expect(results[1].details).toMatchObject({
      status: "failed",
      error: expect.stringContaining("valid GitHub"),
    });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const release of [
      () => session?.abort(),
      () => session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
      () => session?.dispose(),
    ]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Native review context qualification failed");
});
