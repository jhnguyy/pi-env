#!/usr/bin/env node
import { withHeavyweightLock } from "./heavyweight-lock.mjs";
import { SAFE_VERIFICATION_PHASES } from "./verification-phases.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

if (process.argv.includes("--list")) {
  console.log(listPlan(SAFE_VERIFICATION_PHASES).join("\n"));
  process.exit(0);
}

const timeoutMs = Number(process.env.PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS ?? 10 * 60_000);
const exitCode = await withHeavyweightLock(
  (lease) => {
    const inheritedToken = process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
    process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = lease.token;
    try {
      return runPlan(SAFE_VERIFICATION_PHASES, { name: "verify:safe" });
    } finally {
      if (inheritedToken === undefined) delete process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
      else process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = inheritedToken;
    }
  },
  { timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 10 * 60_000 },
);
process.exit(exitCode);
