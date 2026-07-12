import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

export function formatPhase(phase) {
  return phase.skip
    ? `${phase.id}: ${phase.label} — skipped (${phase.skip})`
    : `${phase.id}: ${phase.label} — ${[phase.command, ...phase.args].join(" ")}`;
}

export function listPlan(phases) {
  return phases.map(formatPhase);
}

export function runPlan(phases, options = {}) {
  const run = options.run ?? spawnSync;
  const name = options.name ?? "verify";
  const now = options.now ?? performance.now.bind(performance);
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  for (const phase of phases) {
    if (phase.skip) {
      log(`\n==> ${phase.label} (skipped: ${phase.skip})`);
      continue;
    }
    log(`\n==> ${phase.label}`);
    const startedAt = now();
    const result = run(phase.command, phase.args, { stdio: "inherit" });
    const elapsedMs = Math.max(0, Math.round(now() - startedAt));
    if (result.error) {
      logError(
        `${name}: ${phase.label} failed to start after ${elapsedMs} ms: ${result.error.message}`,
      );
      return 1;
    }
    if (result.status !== 0) {
      logError(`${name}: ${phase.label} failed after ${elapsedMs} ms (exit ${result.status ?? 1})`);
      return result.status ?? 1;
    }
    log(`<== ${phase.label} passed in ${elapsedMs} ms`);
  }
  return 0;
}
