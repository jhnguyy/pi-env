import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function listPlan(steps) {
  return steps.map(({ label, command, args }) => `${label}: ${[command, ...args].join(" ")}`);
}

export function runPlan(steps, { reportDirectory } = {}) {
  const report = {
    node: process.version,
    status: "running",
    phases: steps.map(({ label }) => ({ label, status: "not-run" })),
  };
  if (reportDirectory) {
    reportDirectory = resolve(reportDirectory);
    mkdirSync(reportDirectory, { recursive: true });
  }
  const save = () => {
    if (reportDirectory) {
      writeFileSync(
        join(reportDirectory, "verification.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
  };
  save();
  for (const [index, { label, command, args }] of steps.entries()) {
    const phase = report.phases[index];
    phase.status = "running";
    save();
    console.log(`\n==> ${label}`);
    const startedAt = performance.now();
    const result = spawnSync(command, args, {
      stdio: "inherit",
      ...(reportDirectory && label.startsWith("test:")
        ? {
            env: {
              ...process.env,
              PI_ENV_TEST_REPORT: join(reportDirectory, `${label.replaceAll(":", "-")}.xml`),
            },
          }
        : {}),
    });
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    phase.elapsedMs = elapsedMs;
    phase.exitCode = result.status ?? 1;
    phase.status = result.status === 0 && !result.error ? "passed" : "failed";
    report.status = phase.status === "failed" ? "failed" : "running";
    save();
    if (result.error) {
      console.error(
        `verify: ${label} failed to start after ${elapsedMs} ms: ${result.error.message}`,
      );
      return 1;
    }
    if (result.status !== 0) {
      console.error(`verify: ${label} failed after ${elapsedMs} ms (exit ${result.status ?? 1})`);
      return result.status ?? 1;
    }
    console.log(`<== ${label} passed in ${elapsedMs} ms`);
  }
  report.status = "passed";
  save();
  return 0;
}
