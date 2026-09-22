import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerDevTools } from "../index";
import { sleep } from "./e2e-fixture";
import { LspClient } from "../client";
import { LspDaemon } from "../daemon";
import type {
  DaemonRequest,
  DefinitionResult,
  HoverResult,
  LspResult,
  ReferencesResult,
  SymbolsResult,
} from "../protocol";

const E2E = process.env["E2E"] === "1";
const describeE2E = E2E ? describe : describe.skip;
const repoRoot = process.cwd();
const analyzeFile = `${repoRoot}/.pi/extensions/analyze/index.ts`;
const sharedApiFile = `${repoRoot}/.pi/extensions/_shared/agent-tools.ts`;
const TEST_TIMEOUT_MS = 60_000;

function fixtureClient(socketPath: string): LspClient {
  return new LspClient(socketPath, undefined, {
    spawnDaemon: () => {
      throw new Error("Canary must use its fixture-owned daemon");
    },
  });
}

function sourcePosition(file: string, text: string, symbol: string) {
  const lines = readFileSync(file, "utf8").split("\n");
  const line = lines.findIndex((value) => value.includes(text));
  if (line < 0 || !lines[line].includes(symbol))
    throw new Error(`Canary symbol not found: ${symbol}`);
  return { line: line + 1, character: lines[line].indexOf(symbol) + 1 };
}

function registeredTool(client: LspClient) {
  type Tool = Parameters<Parameters<typeof registerDevTools>[0]["registerTool"]>[0];
  const tools = new Map<string, Pick<Tool, "name" | "execute">>();
  registerDevTools({
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
    exec: async () => {
      throw new Error("Definition lookup must not run unrelated commands");
    },
    events: { emit: () => {} },
    on: () => {},
  }, client);
  const tool = tools.get("dev-tools");
  if (!tool) throw new Error("Public dev-tools tool was not registered");
  return tool;
}

type Fixture = {
  readonly socketPath: string;
  readonly pidPath: string;
  callDaemon(req: Omit<DaemonRequest, "id">): Promise<LspResult>;
  restartDaemon(): Promise<void>;
  cleanup(): Promise<void>;
};

async function startDaemon(socketPath: string, pidPath: string): Promise<LspDaemon> {
  const daemon = new LspDaemon(socketPath, pidPath, 60_000);
  await daemon.start();
  return daemon;
}

async function createRealWorkspaceFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-real-workspace-canary-"));
  const socketPath = join(tmpDir, "lsp.sock");
  const pidPath = join(tmpDir, "lsp.pid");
  let daemon = await startDaemon(socketPath, pidPath);

  return {
    socketPath,
    pidPath,
    async callDaemon(req: Omit<DaemonRequest, "id">): Promise<LspResult> {
      const client = fixtureClient(socketPath);
      try {
        return await client.call(req);
      } finally {
        client.close();
      }
    },
    async restartDaemon(): Promise<void> {
      await daemon.shutdown();
      daemon = await startDaemon(socketPath, pidPath);
    },
    async cleanup(): Promise<void> {
      try {
        await daemon.shutdown();
      } catch {}
      for (const artifact of [socketPath, pidPath]) {
        try {
          if (existsSync(artifact)) unlinkSync(artifact);
        } catch {}
      }
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {}
    },
  };
}

async function measured<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    const elapsedMs = Math.round(performance.now() - start);
    console.info(`[real-workspace-canary] ${label} completed in ${elapsedMs} ms`);
  }
}

function expectSymbol(result: LspResult, name: string): void {
  expect(result.action).toBe("symbols");
  expect((result as SymbolsResult).items.map((item) => item.name)).toContain(name);
}

describeE2E("real workspace semantic canary", () => {
  let fixture: Fixture;
  let publicClient: LspClient;
  let artifactPath: string;
  const evidence: Record<string, unknown> = {
    scenario: "registered dev-tools definition lookup and real-workspace restart",
    repeat: "nub run test:e2e:real-workspace-canary",
    expected: {
      symbol: "registerAgentToolsOnSessionStart",
      destination: relative(repoRoot, sharedApiFile),
    },
    status: "incomplete",
  };

  function saveEvidence() {
    const text = JSON.stringify(evidence, null, 2).replaceAll(repoRoot, "<worktree>");
    if (Buffer.byteLength(text) > 64 * 1024) {
      writeFileSync(
        artifactPath,
        JSON.stringify({
          scenario: evidence.scenario,
          repeat: evidence.repeat,
          status: "incomplete",
          error: "Evidence exceeded 64 KiB",
        }),
      );
      throw new Error("Canary evidence exceeded 64 KiB");
    }
    writeFileSync(artifactPath, `${text}\n`);
  }

  beforeAll(async () => {
    const parent = process.env.PI_ENV_CANARY_ARTIFACT_DIR || tmpdir();
    mkdirSync(parent, { recursive: true });
    artifactPath = join(mkdtempSync(join(parent, "pi-dev-tools-canary-")), "result.json");
    console.info(`Canary evidence: ${artifactPath}`);
    try {
      evidence.revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      evidence.dirty =
        execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim()
          .length > 0;
      evidence.node = process.version;
      saveEvidence();
      fixture = await createRealWorkspaceFixture();
      publicClient = fixtureClient(fixture.socketPath);
    } catch (error) {
      evidence.error = String(error).slice(0, 4000);
      saveEvidence();
      throw error;
    }
  }, 10_000);

  afterAll(async () => {
    publicClient?.close();
    await fixture?.cleanup();
  });

  it(
    "covers real-worktree semantic operations and cold restart behavior",
    async () => {
      try {
        const position = sourcePosition(
          analyzeFile,
          'from "../_shared/agent-tools"',
          "registerAgentToolsOnSessionStart",
        );
        const target = sourcePosition(
          sharedApiFile,
          "export function registerAgentToolsOnSessionStart",
          "registerAgentToolsOnSessionStart",
        );
        evidence.expectedLine = target.line;
        const request = { action: "definition", path: analyzeFile, ...position };
        evidence.request = request;
        const publicResult = await measured("public imported definition", () =>
          registeredTool(publicClient).execute("canary-definition", request, undefined, undefined, {
            cwd: repoRoot,
          } as never),
        );
        evidence.actual = publicResult;
        const definition = publicResult.details as DefinitionResult;
        expect(definition?.action).toBe("definition");
        expect(definition.locations).toMatchObject([
          { absolutePath: sharedApiFile, line: target.line },
        ]);
        expect(
          publicResult.content.some(
            (item) => item.type === "text" && item.text.includes("agent-tools.ts"),
          ),
        ).toBe(true);

        const hoverResult = await measured("imported hover", () =>
          fixture.callDaemon({ action: "hover", path: analyzeFile, ...position }),
        );
        expect(hoverResult.action).toBe("hover");
        expect((hoverResult as HoverResult).signature).toContain(
          "registerAgentToolsOnSessionStart",
        );

        await fixture.restartDaemon();
        const coldSymbols = await measured("cold document symbols", () =>
          fixture.callDaemon({ action: "symbols", path: analyzeFile }),
        );
        expectSymbol(coldSymbols, "analyzeToolSchema");

        await fixture.restartDaemon();
        await measured("shared API symbol warmup", () =>
          fixture.callDaemon({ action: "symbols", path: sharedApiFile }),
        );
        const workspaceSymbols = await measured("workspace symbols", () =>
          fixture.callDaemon({ action: "symbols", query: "ToolCapability" }),
        );
        expectSymbol(workspaceSymbols, "ToolCapability");
        await sleep(3_000);
        const referencesResult = await measured("shared API references", () =>
          fixture.callDaemon({
            action: "references",
            path: sharedApiFile,
            ...sourcePosition(sharedApiFile, "export const ToolCapability", "ToolCapability"),
          }),
        );
        expect(referencesResult.action).toBe("references");
        const references = referencesResult as ReferencesResult;
        evidence.references = references;
        expect(references.total).toBeGreaterThan(20);
        expect(references.items.some((item) => item.absolutePath !== sharedApiFile)).toBe(true);
        expect(references.items.some((item) => item.absolutePath === sharedApiFile)).toBe(true);

        await measured("reference project diagnostics warmup", () =>
          fixture.callDaemon({ action: "diagnostics", path: analyzeFile }),
        );

        await fixture.restartDaemon();
        const restartedSymbols = await measured("post-restart cold document symbols", () =>
          fixture.callDaemon({ action: "symbols", path: analyzeFile }),
        );
        expectSymbol(restartedSymbols, "analyzeToolSchema");
        evidence.status = "passed";
      } catch (error) {
        evidence.status = "failed";
        evidence.error = String(error).slice(0, 4000);
        throw error;
      } finally {
        saveEvidence();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
