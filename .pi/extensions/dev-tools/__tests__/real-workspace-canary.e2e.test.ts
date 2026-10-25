import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerDevTools } from "../index";
import { createLspDaemonFixture, type LspDaemonFixture, sleep } from "./e2e-fixture";
import type { LspClient } from "../client";
import type {
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
const sharedApiFile = `${repoRoot}/.pi/extensions/_shared/tool-render.ts`;
const TEST_TIMEOUT_MS = 60_000;

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
  registerDevTools(
    {
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
      registerCommand: () => {},
      exec: async () => {
        throw new Error("Definition lookup must not run unrelated commands");
      },
    },
    client,
  );
  const tool = tools.get("dev-tools");
  if (!tool) throw new Error("Public dev-tools tool was not registered");
  return tool;
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

function failureMessages(error: unknown): string[] {
  const failures = error instanceof AggregateError ? error.errors : [error];
  return failures.slice(0, 8).map((failure) => String(failure).slice(0, 2000));
}

function expectSymbol(result: LspResult, name: string): void {
  expect(result.action).toBe("symbols");
  expect((result as SymbolsResult).items.map((item) => item.name)).toContain(name);
}

describeE2E("real workspace semantic canary", () => {
  let fixture: LspDaemonFixture;
  let artifactPath: string;
  const evidence: Record<string, unknown> = {
    scenario: "registered dev-tools definition lookup and real-workspace restart",
    repeat: "REAL_WORKSPACE_CANARY=1 nub run test:e2e",
    expected: {
      symbol: "registerPublicTool",
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
      fixture = createLspDaemonFixture();
      await fixture.start();
    } catch (error) {
      evidence.status = "failed";
      evidence.error = String(error).slice(0, 4000);
      evidence.failures = failureMessages(error);
      saveEvidence();
      throw error;
    }
  }, 10_000);

  afterAll(async () => {
    try {
      await fixture?.cleanup();
    } catch (error) {
      evidence.status = "failed";
      evidence.cleanupError = String(error).slice(0, 4000);
      evidence.cleanupFailures = failureMessages(error);
      saveEvidence();
      throw error;
    }
  });

  it(
    "covers real-worktree semantic operations and cold restart behavior",
    async () => {
      try {
        const position = sourcePosition(analyzeFile, "  registerPublicTool,", "registerPublicTool");
        const target = sourcePosition(
          sharedApiFile,
          "export function registerPublicTool",
          "registerPublicTool",
        );
        evidence.expectedLine = target.line;
        const request = { action: "definition", path: analyzeFile, ...position };
        evidence.request = request;
        const publicResult = await measured("public imported definition", () =>
          fixture.withClient((client) =>
            registeredTool(client).execute("canary-definition", request, undefined, undefined, {
              cwd: repoRoot,
            } as never),
          ),
        );
        evidence.actual = publicResult;
        const definition = publicResult.details as DefinitionResult;
        expect(definition?.action).toBe("definition");
        expect(definition.locations).toMatchObject([
          { absolutePath: sharedApiFile, line: target.line },
        ]);
        expect(
          publicResult.content.some(
            (item) => item.type === "text" && item.text.includes("tool-render.ts"),
          ),
        ).toBe(true);

        const hoverResult = await measured("imported hover", () =>
          fixture.callDaemon({ action: "hover", path: analyzeFile, ...position }),
        );
        expect(hoverResult.action).toBe("hover");
        expect((hoverResult as HoverResult).signature).toContain("registerPublicTool");

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
          fixture.callDaemon({ action: "symbols", query: "registerPublicTool" }),
        );
        expectSymbol(workspaceSymbols, "registerPublicTool");
        await sleep(3_000);
        const referencesResult = await measured("shared API references", () =>
          fixture.callDaemon({
            action: "references",
            path: sharedApiFile,
            ...sourcePosition(
              sharedApiFile,
              "export function registerPublicTool",
              "registerPublicTool",
            ),
          }),
        );
        expect(referencesResult.action).toBe("references");
        const references = referencesResult as ReferencesResult;
        evidence.references = references;
        expect(references.total).toBeGreaterThan(1);
        expect(references.items.some((item) => item.absolutePath === analyzeFile)).toBe(true);
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
        evidence.failures = failureMessages(error);
        throw error;
      } finally {
        saveEvidence();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
