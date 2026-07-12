#!/usr/bin/env node
import { withHeavyweightLock } from "./heavyweight-lock.mjs";
import {
  SAFE_VERIFICATION_PHASES,
  formatSafePhase,
  runSafeVerificationPlan,
} from "./safe-verification-plan.mjs";

if (process.argv.includes("--list")) {
  console.log(SAFE_VERIFICATION_PHASES.map(formatSafePhase).join("\n"));
  process.exit(0);
}

const timeoutMs = Number(process.env.PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS ?? 10 * 60_000);
const exitCode = await withHeavyweightLock(
  (lease) => {
    const inheritedToken = process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
    process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = lease.token;
    try {
      return runSafeVerificationPlan();
    } finally {
      if (inheritedToken === undefined) delete process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
      else process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = inheritedToken;
    }
  },
  { timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 10 * 60_000 },
);
process.exit(exitCode);
