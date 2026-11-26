import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

export function listPlan(steps) {
  return steps.map(({ label, command, args }) => `${label}: ${[command, ...args].join(" ")}`);
}

export function runPlan(steps, { reportDirectory } = {}) {
  const phases = steps.map(({ label }) => ({ label, status: "not run", elapsedMs: undefined }));
  if (reportDirectory) {
    reportDirectory = resolve(reportDirectory);
    mkdirSync(reportDirectory, { recursive: true });
  }
  const save = () => {
    if (!reportDirectory) return;
    const rows = phases.map(
      ({ label, status, elapsedMs }) =>
        `| ${label} | ${status} | ${elapsedMs === undefined ? "—" : `${(elapsedMs / 1000).toFixed(2)}s`} |`,
    );
    writeFileSync(
      join(reportDirectory, "verification.md"),
      `## Full verification

Node: ${process.version}

| Check | Result | Duration |
| --- | --- | --- |
${rows.join("\n")}
`,
    );
  };
  save();
  for (const [index, { label, command, args }] of steps.entries()) {
    const phase = phases[index];
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
    phase.status = result.status === 0 && !result.error ? "passed" : "failed";
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
  return 0;
}
