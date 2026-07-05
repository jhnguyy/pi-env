import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { AgentEndIssueSeverity, AgentEndResultKind } from "../agent-end";
import { CodeSensorSeverity, loadCodeSensorConfig, runConfiguredCodeSensors } from "../code-sensors";
import { BackendName } from "../backend-configs";

function spawnResult(status: number, stderr = "", stdout = ""): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

function makeRepo(config: unknown): string {
  const cwd = join(tmpdir(), `pi-env-code-sensors-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/code-sensors.json"), JSON.stringify(config), "utf8");
  return cwd;
}

describeIfEnabled("dev-tools", "configured code sensors", () => {
  it("loads a validated sensor config", () => {
    const cwd = makeRepo({ sensors: [{ name: "depcruise", command: "depcruise src", include: [".ts"] }] });

    expect(loadCodeSensorConfig(cwd)).toEqual({
      version: 1,
      sensors: [{
        name: "depcruise",
        command: "depcruise src",
        include: [".ts"],
        timeoutMs: 120_000,
        severity: CodeSensorSeverity.Error,
      }],
    });
  });

  it("runs matching command sensors and maps failures to agent-end issues", async () => {
    const cwd = makeRepo({ sensors: [{ name: "jscpd", command: "jscpd .", include: ["src/"] }] });
    const runCommand = vi.fn(() => spawnResult(1, "duplicate block found\nmore detail"));

    const results = await runConfiguredCodeSensors(cwd, [join(cwd, "src/app.ts")], { runCommand });

    expect(runCommand).toHaveBeenCalledWith("jscpd .", cwd, 120_000);
    expect(results).toEqual([expect.objectContaining({
      kind: AgentEndResultKind.Sensor,
      backend: BackendName.Sensor,
      filePath: join(cwd, ".pi/code-sensors.json"),
      issues: [{ severity: AgentEndIssueSeverity.Error, message: "jscpd: duplicate block found" }],
    })]);
  });

  it("rejects invalid sensor severities instead of silently defaulting", () => {
    const cwd = makeRepo({ sensors: [{ name: "bad", command: "bad", severity: "notice" }] });

    expect(() => loadCodeSensorConfig(cwd)).toThrow(/severity must be "error" or "warning"/);
  });

  it("rejects unsupported config versions and invalid timeouts", () => {
    const wrongVersion = makeRepo({ version: 2, sensors: [] });
    const badTimeout = makeRepo({ sensors: [{ name: "bad", command: "bad", timeoutMs: 0 }] });

    expect(() => loadCodeSensorConfig(wrongVersion)).toThrow(/version must be 1/);
    expect(() => loadCodeSensorConfig(badTimeout)).toThrow(/timeoutMs must be a positive finite number/);
  });

  it("rejects empty include patterns", () => {
    const cwd = makeRepo({ sensors: [{ name: "bad", command: "bad", include: [""] }] });

    expect(() => loadCodeSensorConfig(cwd)).toThrow(/include must be an array of strings/);
  });

  it("skips sensors whose include filters do not match edited files", async () => {
    const cwd = makeRepo({ sensors: [{ name: "knip", command: "knip", include: ["src/"] }] });
    const runCommand = vi.fn(() => spawnResult(1, "unused"));

    await expect(runConfiguredCodeSensors(cwd, [join(cwd, "README.md")], { runCommand })).resolves.toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
