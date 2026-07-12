import { spawnSync } from "node:child_process";

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
  for (const phase of phases) {
    if (phase.skip) {
      console.log(`\n==> ${phase.label} (skipped: ${phase.skip})`);
      continue;
    }
    console.log(`\n==> ${phase.label}`);
    const result = run(phase.command, phase.args, { stdio: "inherit" });
    if (result.error) {
      console.error(`${name}: ${phase.label} failed to start: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}
