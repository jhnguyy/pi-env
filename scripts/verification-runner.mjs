import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

export function listPlan(steps) {
  return steps.map(({ label, command, args }) => `${label}: ${[command, ...args].join(" ")}`);
}

export function runPlan(steps) {
  for (const { label, command, args } of steps) {
    console.log(`\n==> ${label}`);
    const startedAt = performance.now();
    const result = spawnSync(command, args, { stdio: "inherit" });
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
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
