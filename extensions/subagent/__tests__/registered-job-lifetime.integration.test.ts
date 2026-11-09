import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createCodemodeExtension,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import initSubagent from "../index";
import type { SubagentJobRenderDetails } from "../types";
import { settleOperations, testCleanup } from "./cleanup";

it.each([
  { transport: "direct", ending: "complete" },
  { transport: "codemode", ending: "complete" },
  { transport: "direct", ending: "interrupt" },
  { transport: "codemode", ending: "interrupt" },
])(
  "keeps accepted running and queued jobs across parent $ending and next input ($transport)",
  async ({ transport, ending }) => {
    const root = await mkdtemp(join(tmpdir(), "registered-job-lifetime-"));
    const cleanup = testCleanup();
    cleanup(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    let parent: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
    let unsubscribe: (() => void) | undefined;
    const operations: Promise<unknown>[] = [];
    cleanup(
      () => unsubscribe?.(),
      async () => {
        for (const marker of ["first", "second", "parent"])
          await writeFile(join(root, `release-${marker}`), "release");
      },
      () => parent?.abort(),
      () => parent?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
      () => settleOperations(operations),
      () => parent?.dispose(),
      () => vi.unstubAllEnvs(),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: [fileURLToPath(new URL("./fixtures/job-lifetime.ts", import.meta.url))],
        defaultProvider: "job-lifetime",
        defaultModel: "faux-1",
        defaultTools: ["child_gate"],
      }),
    );
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: { "job-lifetime": { apiKey: "fixture-key" } },
      }),
    );
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: true }),
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
      resourceLoaderOptions: {
        extensionFactories: [initSubagent, createCodemodeExtension({ mode: "on" })],
      },
    });
    parent = (
      await createAgentSessionFromServices({
        services,
        tools: ["subagent", "parent_gate", "codemode"],
        sessionManager: SessionManager.create(root, join(root, "sessions")),
      })
    ).session;
    await parent.bindExtensions({ mode: "print" });
    const accepted: SubagentJobRenderDetails[] = [];
    unsubscribe = parent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "subagent" && !event.isError)
        accepted.push(event.result.details as SubagentJobRenderDetails);
    });
    const first = parent.prompt(`launch ${transport} ${ending}`);
    operations.push(first);
    void first.catch(() => {});
    await vi.waitFor(
      () => {
        expect(accepted).toHaveLength(2);
        expect(existsSync(join(root, "entered-first"))).toBe(true);
        if (ending === "interrupt") expect(existsSync(join(root, "entered-parent"))).toBe(true);
      },
      { timeout: 15000 },
    );
    if (ending === "interrupt") await parent.abort();
    await first;
    if (ending === "interrupt")
      expect(await readFile(join(root, "settled-parent"), "utf8")).toBe("aborted");
    else expect(parent.getLastAssistantText()).toBe("Parent ready");
    unsubscribe();
    await parent.prompt("ordinary next input");
    expect(parent.getLastAssistantText()).toBe("Next parent reply");
    const query = async (action: "status" | "wait") => {
      const before = parent.messages.length;
      await parent.prompt(
        `operations:${JSON.stringify(accepted.map(({ jobId }) => ({ action, job_id: jobId })))}`,
      );
      return parent.messages
        .slice(before)
        .flatMap((message) =>
          message.role === "toolResult" && message.toolName === "subagent" ? [message] : [],
        );
    };
    const statuses = await query("status");
    expect(statuses.map((result) => (result.details as SubagentJobRenderDetails).status)).toEqual([
      "running",
      "queued",
    ]);
    for (const marker of ["first", "second"]) {
      await writeFile(join(root, `release-${marker}`), "release");
      await vi.waitFor(() => expect(existsSync(join(root, `settled-${marker}`))).toBe(true), {
        timeout: 15000,
      });
      expect(await readFile(join(root, `settled-${marker}`), "utf8")).toBe("released");
    }
    const results = await query("wait");
    expect(results.map((result) => (result.details as SubagentJobRenderDetails).status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(results.map((result) => result.content)).toEqual([
      [{ type: "text", text: "answer first" }],
      [{ type: "text", text: "answer second" }],
    ]);
    for (const marker of ["first", "second"])
      expect(await readFile(join(root, `entered-${marker}`), "utf8")).toBe("entered\n");
  },
  60000,
);
