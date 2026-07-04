import type { SpawnSyncReturns } from "node:child_process";
import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
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
      kind: "format",
      backend: BackendName.Terraform,
      filePath: "/repo/main.tf",
      issues: [{ severity: "error", message: "fmt failed" }],
    });
  });

  it("treats diagnostics transport failures as best-effort", async () => {
    await expect(collectDiagnosticsAgentEndResults(["/repo/a.ts"], async () => {
      throw new Error("daemon unavailable");
    })).resolves.toEqual([]);
  });

  it("processes a whole batch and triggers only for LSP errors", async () => {
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
    expect(result.summary).toContain("a.ts (typescript):");
    expect(result.summary).toContain("main.tf (terraform):");
    expect(result.summary).toContain("fmt failed");
    expect([...active.keys()].sort()).toEqual(["/repo/a.ts", "/repo/main.tf"]);
  });
});
