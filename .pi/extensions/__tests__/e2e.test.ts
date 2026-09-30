import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Real Pi registry and built bundles; no provider call or network is required. */
describe("native tool discovery", () => {
  it("keeps deferred tools callable and loads them through Pi's tool_search", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-native-tools-"));
    const evidenceDir = process.env.PI_ENV_NATIVE_TOOL_ARTIFACT_DIR ?? tmpdir();
    mkdirSync(evidenceDir, { recursive: true });
    const artifact = join(mkdtempSync(join(evidenceDir, "pi-native-tools-")), "result.json");
    const evidence: Record<string, unknown> = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim().length > 0,
      repeat: "E2E=1 nub run test:vitest .pi/extensions/__tests__/e2e.test.ts",
      input: { defaultTools: ["+codemode", "+tool_search"], query: "web fetch", limit: 1 },
      expected: { activeBefore: ["codemode", "tool_search"], callableBefore: ["analyze", "web_fetch"], loaded: "web_fetch" },
      actual: {},
      verdict: "failed",
    };
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode", "+tool_search"] });
      const resourceLoader = new DefaultResourceLoader({
        cwd: workspace,
        agentDir: workspace,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [
          join(repo, ".pi/extensions/analyze/dist/index.js"),
          join(repo, ".pi/extensions/web-context/dist/index.js"),
        ],
        extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension()],
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd: workspace,
        agentDir: workspace,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(),
      }));
      await session.bindExtensions({});
      const activeBefore = session.getActiveToolNames();
      const callableBefore = session.getCallableToolNames();
      evidence.actual = { activeBefore, callableBefore };
      expect(activeBefore).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
      expect(activeBefore).not.toContain("web_fetch");
      expect(callableBefore).toEqual(expect.arrayContaining(["analyze", "web_fetch"]));
      expect(callableBefore).not.toContain("tool_search");

      const toolSearch = session.getToolDefinition("tool_search");
      expect(toolSearch).toBeDefined();
      const result = await toolSearch!.execute("search-test", { query: "web fetch", limit: 1 }, undefined, undefined, {} as ExtensionToolContext);
      const activeAfter = session.getActiveToolNames();
      evidence.actual = { activeBefore, callableBefore, activeAfter, loaded: result.details };
      expect(result.details).toEqual({ loaded: ["web_fetch"] });
      expect(activeAfter).toContain("web_fetch");
      evidence.verdict = "passed";
    } finally {
      session?.dispose();
      writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n");
      console.info(`Native tool evidence: ${artifact}`);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
