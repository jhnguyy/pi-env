#!/usr/bin/env node
import * as HeavyweightLock from "./heavyweight-lock.mjs";
import * as VerificationPhases from "./verification-phases.mjs";
import * as VerificationRunner from "./verification-runner.mjs";

if (process.argv.includes("--list")) {
  console.log(VerificationRunner.listPlan(VerificationPhases.SAFE_VERIFICATION_PHASES).join("\n"));
  process.exit(0);
}

const exitCode = await HeavyweightLock.withHeavyweightLock(
  (lease) => {
    const inheritedToken = process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
    process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = lease.token;
    try {
      return VerificationRunner.runPlan(VerificationPhases.SAFE_VERIFICATION_PHASES, {
        name: "verify:safe",
      });
    } finally {
      if (inheritedToken === undefined) delete process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
      else process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = inheritedToken;
    }
  },
  { timeoutMs: HeavyweightLock.heavyweightLockTimeoutMs() },
);
process.exit(exitCode);
