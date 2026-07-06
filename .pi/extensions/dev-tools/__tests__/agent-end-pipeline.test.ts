import type { SpawnSyncReturns } from "node:child_process";
import { expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { AgentEndIssueSeverity, AgentEndResultKind } from "../agent-end";
import { AgentEndReadiness } from "../agent-end-review";
import { BackendName } from "../backend-configs";
import {
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

  it("processes a formatter batch with review-readiness metadata", async () => {
    const active = new Map();

    const result = await processAgentEndBatch(active, ["/repo/a.ts", "/repo/main.tf"], {
      resolveFormatBinary: () => "terraform",
      runFormat: () => spawnResult(1, "fmt failed"),
    });

    expect(result.triggerTurn).toBe(false);
    expect(result.metadata.readiness).toBe(AgentEndReadiness.Blocked);
    expect(result.summary).toContain("Post-edit checks completed.");
    expect(result.summary).toContain("Readiness: blocked");
    expect(result.summary).toContain("main.tf (terraform):");
    expect(result.summary).toContain("fmt failed");
    expect([...active.keys()].sort()).toEqual(["/repo/main.tf"]);
  });

  it("does not send post-edit feedback when only manual-diagnostic files changed", async () => {
    const active = new Map();

    const result = await processAgentEndBatch(active, ["/repo/a.ts", "/repo/README.md"], {
      resolveFormatBinary: () => null,
      runFormat: () => spawnResult(0),
    });

    expect(result.triggerTurn).toBe(false);
    expect(result.metadata).toMatchObject({
      checkedFiles: [],
      skippedFiles: ["/repo/a.ts", "/repo/README.md"],
      issueCounts: { errors: 0, warnings: 0, infos: 0 },
      readiness: AgentEndReadiness.NotChecked,
    });
    expect(result.summary).toBe("");
  });

});
