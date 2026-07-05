import type { SpawnSyncReturns } from "node:child_process";
import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { AgentEndIssueSeverity, AgentEndResultKind } from "../agent-end";
import { AgentEndBackendCheckKind, AgentEndReadiness } from "../agent-end-review";
import { BackendName } from "../backend-configs";
import {
  collectDiagnosticsAgentEndResults,
  collectFormatAgentEndResults,
  partitionAgentEndFiles,
  processAgentEndBatch,
} from "../agent-end-pipeline";

function spawnResult(status: number, stderr = ""): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, "", stderr],
    stdout: "",
    stderr,
    status,
    signal: null,
  };
}

describeIfEnabled("dev-tools", "agent_end pipeline", () => {
  it("partitions edited files by backend mode", () => {
    const partition = partitionAgentEndFiles([
      "/repo/src/app.ts",
      "/repo/setup.sh",
      "/repo/main.tf",
      "/repo/README.md",
    ]);

    expect(partition.lspFiles).toEqual(["/repo/src/app.ts", "/repo/setup.sh"]);
    expect(partition.formatFiles.map((entry) => [entry.file, entry.config.name])).toEqual([
      ["/repo/main.tf", BackendName.Terraform],
    ]);
    expect(partition.skippedFiles).toEqual(["/repo/README.md"]);
  });

  it("normalizes formatter failures without invoking missing binaries", () => {
    const { formatFiles } = partitionAgentEndFiles(["/repo/main.tf", "/repo/terragrunt.hcl"]);
    const runFormat = vi.fn((bin: string, _args: string[]) => (
      bin === "terraform" ? spawnResult(1, "fmt failed") : spawnResult(0)
    ));

    const results = collectFormatAgentEndResults(formatFiles, {
      resolveFormatBinary: (name) => name === "terraform" ? "terraform" : null,
      runFormat,
    });

    expect(runFormat).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: AgentEndResultKind.Format,
      backend: BackendName.Terraform,
      filePath: "/repo/main.tf",
      issues: [{ severity: AgentEndIssueSeverity.Error, message: "fmt failed" }],
    });
  });

  it("treats diagnostics transport failures as best-effort", async () => {
    await expect(collectDiagnosticsAgentEndResults(["/repo/a.ts"], async () => {
      throw new Error("daemon unavailable");
    })).resolves.toEqual([]);
  });

  it("processes a whole batch with review-readiness metadata", async () => {
    const active = new Map();

    const result = await processAgentEndBatch(active, ["/repo/a.ts", "/repo/main.tf"], {
      resolveFormatBinary: () => "terraform",
      runFormat: () => spawnResult(1, "fmt failed"),
      runDiagnostics: async (paths) => ({
        action: "diagnostics",
        path: "",
        errorCount: 1,
        warnCount: 0,
        language: "typescript",
        items: [],
        files: paths.map((path) => ({
          action: "diagnostics",
          path,
          language: "typescript",
          errorCount: 1,
          warnCount: 0,
          items: [{ severity: "error", line: 2, character: 3, code: "TS1", message: "broken" }],
        })),
      }),
    });

    expect(result.triggerTurn).toBe(true);
    expect(result.metadata.readiness).toBe(AgentEndReadiness.Blocked);
    expect(result.summary).toContain("Code sensors completed.");
    expect(result.summary).toContain("Readiness: blocked");
    expect(result.summary).toContain("a.ts (typescript):");
    expect(result.summary).toContain("main.tf (terraform):");
    expect(result.summary).toContain("fmt failed");
    expect([...active.keys()].sort()).toEqual(["/repo/a.ts", "/repo/main.tf"]);
  });

  it("reports clean diagnostic metadata without forcing a readiness follow-up", async () => {
    const active = new Map();

    const result = await processAgentEndBatch(active, ["/repo/a.ts", "/repo/README.md"], {
      resolveFormatBinary: () => null,
      runFormat: () => spawnResult(0),
      runDiagnostics: async () => ({
        action: "diagnostics",
        path: "/repo/a.ts",
        errorCount: 0,
        warnCount: 0,
        language: "typescript",
        items: [],
      }),
    });

    expect(result.triggerTurn).toBe(false);
    expect(result.metadata).toMatchObject({
      checkedFiles: ["/repo/a.ts"],
      skippedFiles: ["/repo/README.md"],
      issueCounts: { errors: 0, warnings: 0, infos: 0 },
      readiness: AgentEndReadiness.Ready,
    });
    expect(result.summary).toContain("Checked: 1 (a.ts)");
    expect(result.summary).toContain("Skipped unsupported/unavailable: 1 (README.md)");
    expect(result.summary).toContain("Readiness: clean. No post-edit issues were found.");
  });

  it("includes configured code sensors in readiness metadata", async () => {
    const active = new Map();

    const result = await processAgentEndBatch(active, ["/repo/a.ts"], {
      resolveFormatBinary: () => null,
      runFormat: () => spawnResult(0),
      runDiagnostics: async () => ({
        action: "diagnostics",
        path: "/repo/a.ts",
        errorCount: 0,
        warnCount: 0,
        language: "typescript",
        items: [],
      }),
      runCodeSensors: async () => [{
        kind: AgentEndResultKind.Sensor,
        backend: BackendName.Sensor,
        filePath: "/repo/.pi/code-sensors.json",
        fileName: ".pi/code-sensors.json",
        issues: [{ severity: AgentEndIssueSeverity.Error, message: "depcruise: boundary violation" }],
      }],
    });

    expect(result.triggerTurn).toBe(true);
    expect(result.metadata.readiness).toBe(AgentEndReadiness.Blocked);
    expect(result.metadata.backendChecks).toContainEqual({ kind: AgentEndBackendCheckKind.Sensor, backend: BackendName.Sensor, files: ["/repo/a.ts"] });
    expect(result.summary).toContain("sensor:sensor 1");
    expect(result.summary).toContain("depcruise: boundary violation");
  });

  it("uses sensor issue counts for readiness even when no files have LSP or formatter coverage", async () => {
    const active = new Map();

    const result = await processAgentEndBatch(active, ["/repo/package.json"], {
      resolveFormatBinary: () => null,
      runFormat: () => spawnResult(0),
      runDiagnostics: async () => null,
      runCodeSensors: async () => [{
        kind: AgentEndResultKind.Sensor,
        backend: BackendName.Sensor,
        filePath: "/repo/.pi/code-sensors.json",
        fileName: ".pi/code-sensors.json",
        issues: [{ severity: AgentEndIssueSeverity.Warning, message: "knip: unused export" }],
      }],
    });

    expect(result.triggerTurn).toBe(false);
    expect(result.metadata.readiness).toBe(AgentEndReadiness.ReviewWarnings);
    expect(result.summary).toContain("Readiness: warnings");
    expect(result.summary).toContain("knip: unused export");
  });

  it("reports code sensor execution failures as blocking sensor issues", async () => {
    const active = new Map();

    const result = await processAgentEndBatch(active, ["/repo/package.json"], {
      resolveFormatBinary: () => null,
      runFormat: () => spawnResult(0),
      runDiagnostics: async () => null,
      runCodeSensors: async () => {
        throw new Error("invalid .pi/code-sensors.json");
      },
    });

    expect(result.triggerTurn).toBe(true);
    expect(result.metadata.readiness).toBe(AgentEndReadiness.Blocked);
    expect(result.summary).toContain("code sensors failed: invalid .pi/code-sensors.json");
    expect([...active.keys()]).toEqual([".pi/code-sensors.json"]);
  });

  it("clears stale sensor results when configured sensors pass later", async () => {
    const active = new Map();
    const cleanDiagnostics = async () => ({
      action: "diagnostics" as const,
      path: "/repo/a.ts",
      errorCount: 0,
      warnCount: 0,
      language: "typescript",
      items: [],
    });

    await processAgentEndBatch(active, ["/repo/a.ts"], {
      resolveFormatBinary: () => null,
      runFormat: () => spawnResult(0),
      runDiagnostics: cleanDiagnostics,
      runCodeSensors: async () => [{
        kind: AgentEndResultKind.Sensor,
        backend: BackendName.Sensor,
        filePath: "/repo/.pi/code-sensors.json",
        fileName: ".pi/code-sensors.json",
        issues: [{ severity: AgentEndIssueSeverity.Error, message: "depcruise: boundary violation" }],
      }],
    });

    expect([...active.keys()]).toEqual(["/repo/.pi/code-sensors.json"]);

    await processAgentEndBatch(active, ["/repo/a.ts"], {
      resolveFormatBinary: () => null,
      runFormat: () => spawnResult(0),
      runDiagnostics: cleanDiagnostics,
      runCodeSensors: async () => [],
    });

    expect(active.size).toBe(0);
  });
});
