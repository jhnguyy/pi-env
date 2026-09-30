import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundles = ["analyze", "web-context", "dev-tools", "security", "skill-builder", "subagent"].map(
  (name) => join(repo, `.pi/extensions/${name}/dist/index.js`),
);

/** Real Pi session and built bundles, with a scripted provider and synthetic network response. */
describe("native tool discovery", () => {
  it("keeps deferred tools callable and loads them through Pi's tool_search", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-native-tools-"));
    const evidenceDir = process.env.PI_ENV_NATIVE_TOOL_ARTIFACT_DIR ?? tmpdir();
    mkdirSync(evidenceDir, { recursive: true });
    const artifact = join(mkdtempSync(join(evidenceDir, "pi-native-tools-")), "result.json");
    const evidence: Record<string, unknown> = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim().length > 0,
      repeat: "nub run build && nub run test:e2e:native-tools",
      input: {
        defaultTools: ["+codemode", "+tool_search"],
        query: "web fetch",
        limit: 1,
        sensitiveFixture: ".env (synthetic)",
        webFixture: "https://example.invalid/pi-env-fixture (synthetic response)",
        bundles: bundles.map((path) => path.slice(repo.length + 1)),
      },
      expected: {
        activeBefore: ["codemode", "tool_search", "closeout", "skill_build", "subagent"],
        callableBefore: ["analyze", "web_fetch"],
        notCallable: ["closeout", "skill_build", "subagent"],
        loaded: "web_fetch through model-issued search",
        webFetches: "synthetic result from deferred codemode and activated direct calls",
        sensitiveReads: "redacted in direct and codemode calls",
      },
      actual: {},
      verdict: "failed",
    };
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousTelemetry = process.env.PI_TELEMETRY;
    const previousFetch = globalThis.fetch;
    process.env.PI_CODING_AGENT_DIR = workspace;
    process.env.PI_TELEMETRY = "0";
    let fetchCount = 0;
    try {
      evidence.bundleHashes = Object.fromEntries(bundles.map((path) => [path.slice(repo.length + 1), createHash("sha256").update(readFileSync(path)).digest("hex")]));
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode", "+tool_search"] });
      const faux = fauxProvider();
      const modelRuntime = await ModelRuntime.create({
        authPath: join(workspace, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      const resourceLoader = new DefaultResourceLoader({
        cwd: workspace,
        agentDir: workspace,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: bundles,
        extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension()],
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd: workspace,
        agentDir: workspace,
        modelRuntime,
        model: faux.getModel(),
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(),
      }));
      await session.bindExtensions({});
      const activeBefore = session.getActiveToolNames();
      const callableBefore = session.getCallableToolNames();
      evidence.actual = { activeBefore, callableBefore };
      expect(activeBefore).toEqual(expect.arrayContaining(["codemode", "tool_search", "closeout", "skill_build", "subagent"]));
      expect(activeBefore).not.toContain("web_fetch");
      expect(callableBefore).toEqual(expect.arrayContaining(["analyze", "web_fetch"]));
      for (const name of ["tool_search", "closeout", "skill_build", "subagent"]) expect(callableBefore).not.toContain(name);

      const webUrl = "https://example.invalid/pi-env-fixture";
      globalThis.fetch = async (input) => {
        const requestedUrl = input instanceof Request ? input.url : String(input);
        if (requestedUrl !== webUrl) throw new Error(`Unexpected test fetch: ${requestedUrl}`);
        fetchCount += 1;
        return new Response("synthetic-web-fixture", { status: 200, headers: { "content-type": "text/plain" } });
      };
      const sensitivePath = join(workspace, ".env");
      const ordinaryPath = join(workspace, "ordinary.txt");
      writeFileSync(sensitivePath, "synthetic-credential-fixture");
      writeFileSync(ordinaryPath, "ordinary-fixture");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", {
          code: `text(await tools.web_fetch({ url: ${JSON.stringify(webUrl)}, mode: "raw" }))`,
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("tool_search", { query: "web fetch", limit: 1 }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("web_fetch", { url: webUrl, mode: "raw" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("codemode", {
          code: `text(await tools.read({ path: ${JSON.stringify(sensitivePath)} }))`,
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("read", { path: sensitivePath }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("read", { path: ordinaryPath }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("Fetch the synthetic web fixture through codemode before discovery.");
      expect(session.getActiveToolNames()).not.toContain("web_fetch");
      expect(JSON.stringify(session.messages)).toContain("synthetic-web-fixture");
      await session.prompt("Search for the web fetch tool.");
      const activeAfter = session.getActiveToolNames();
      const searchResult = session.messages.find((message) => message.role === "toolResult" && message.toolName === "tool_search");
      const searchDetails = searchResult && "details" in searchResult ? searchResult.details : undefined;
      expect(searchDetails).toEqual({ loaded: ["web_fetch"] });
      expect(activeAfter).toContain("web_fetch");
      await session.prompt("Fetch the synthetic web fixture directly.");
      const directFetch = session.messages.find((message) => message.role === "toolResult" && message.toolName === "web_fetch");
      expect(JSON.stringify(directFetch)).toContain("synthetic-web-fixture");
      await session.prompt("Read the sensitive fixture through codemode.");
      await session.prompt("Read the sensitive fixture directly.");
      await session.prompt("Read the ordinary fixture directly.");
      const transcript = JSON.stringify(session.messages);
      evidence.actual = {
        activeBefore, callableBefore, activeAfter, loaded: searchDetails,
        webFetches: fetchCount,
        sensitiveReadRedactions: transcript.match(/\[\.env redacted/g)?.length ?? 0,
        ordinaryRead: transcript.includes("ordinary-fixture"),
        syntheticFixtureInTranscript: transcript.includes("synthetic-credential-fixture"),
        fauxCalls: faux.state.callCount,
      };
      expect(transcript).not.toContain("synthetic-credential-fixture");
      expect(evidence.actual).toEqual(expect.objectContaining({ webFetches: 2, sensitiveReadRedactions: 2, ordinaryRead: true, syntheticFixtureInTranscript: false, fauxCalls: 12 }));
      evidence.verdict = "passed";
    } finally {
      session?.dispose();
      globalThis.fetch = previousFetch;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousTelemetry === undefined) delete process.env.PI_TELEMETRY;
      else process.env.PI_TELEMETRY = previousTelemetry;
      writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n");
      console.info(`Native tool evidence: ${artifact}`);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
