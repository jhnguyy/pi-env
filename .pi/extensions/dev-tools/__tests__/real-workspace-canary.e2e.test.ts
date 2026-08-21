import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sleep } from "./e2e-fixture";
import { LspClient } from "../client";
import { LspDaemon } from "../daemon";
import type { DefinitionResult, HoverResult, LspResult, ReferencesResult, SymbolsResult } from "../protocol";

const E2E = process.env["E2E"] === "1";
const describeE2E = E2E ? describe : describe.skip;
const repoRoot = process.cwd();
const analyzeFile = `${repoRoot}/.pi/extensions/analyze/index.ts`;
const sharedApiFile = `${repoRoot}/.pi/extensions/_shared/agent-tools.ts`;
const TEST_TIMEOUT_MS = 60_000;

type Fixture = {
  readonly socketPath: string;
  readonly pidPath: string;
  callDaemon(req: object): Promise<LspResult>;
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
    async callDaemon(req: object): Promise<LspResult> {
      const client = new LspClient(socketPath, undefined, {
        spawnDaemon: () => {
          throw new Error("real-workspace canary must use its fixture-owned daemon");
        },
      });
      try {
        return await client.call(req as never);
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

  beforeAll(async () => {
    fixture = await createRealWorkspaceFixture();
  }, 10_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("covers real-worktree semantic operations and cold restart behavior", async () => {
    const definitionResult = await measured("imported definition", () =>
      fixture.callDaemon({ action: "definition", path: analyzeFile, line: 7, character: 10 }),
    );
    expect(definitionResult.action).toBe("definition");
    const definition = definitionResult as DefinitionResult;
    expect(definition.locations.some((location) => location.absolutePath === sharedApiFile)).toBe(true);

    const hoverResult = await measured("imported hover", () =>
      fixture.callDaemon({ action: "hover", path: analyzeFile, line: 7, character: 10 }),
    );
    expect(hoverResult.action).toBe("hover");
    expect((hoverResult as HoverResult).signature).toContain("registerAgentToolsOnSessionStart");

    await fixture.restartDaemon();
    const coldSymbols = await measured("cold document symbols", () =>
      fixture.callDaemon({ action: "symbols", path: analyzeFile }),
    );
    expectSymbol(coldSymbols, "analyzeToolSchema");

    await fixture.restartDaemon();
    const sharedSymbols = await measured("shared API symbol warmup", () =>
      fixture.callDaemon({ action: "symbols", path: sharedApiFile }),
    );
    expectSymbol(sharedSymbols, "ToolCapability");
    const workspaceSymbols = await measured("workspace symbols", () =>
      fixture.callDaemon({ action: "symbols", query: "ToolCapability" }),
    );
    expectSymbol(workspaceSymbols, "ToolCapability");
    await sleep(3_000);
    const referencesResult = await measured("shared API references", () =>
      fixture.callDaemon({ action: "references", path: sharedApiFile, line: 25, character: 14 }),
    );
    expect(referencesResult.action).toBe("references");
    const references = referencesResult as ReferencesResult;
    expect(references.total).toBeGreaterThan(20);
    expect(references.items.some((item) => item.absolutePath === sharedApiFile)).toBe(true);

    await measured("reference project diagnostics warmup", () =>
      fixture.callDaemon({ action: "diagnostics", path: analyzeFile }),
    );

    await fixture.restartDaemon();
    const restartedSymbols = await measured("post-restart cold document symbols", () =>
      fixture.callDaemon({ action: "symbols", path: analyzeFile }),
    );
    expectSymbol(restartedSymbols, "analyzeToolSchema");
  }, TEST_TIMEOUT_MS);
});
