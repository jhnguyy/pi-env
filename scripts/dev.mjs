#!/usr/bin/env node
import { constants as osConstants } from "node:os";
import { parseArgs } from "node:util";
import * as HeavyweightLock from "./heavyweight-lock.mjs";
import { changedFiles } from "./changed-files.mjs";
import { changedVerificationPlan, unqualifiedGlobalInputs } from "./verification-plan.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

async function verify(args) {
  const {
    values: { base, list, "checks-only": checksOnly },
  } = parseArgs({
    args,
    options: {
      base: { type: "string" },
      list: { type: "boolean" },
      "checks-only": { type: "boolean" },
    },
  });
  const change = changedFiles({ base });
  const steps = changedVerificationPlan(change, { checksOnly });
  console.log(`Verification scope: ${change.files.length} changed paths since ${change.base}.`);
  console.log("Local feedback does not replace CI's changed-file policy and integration checks.");
  const unqualified = unqualifiedGlobalInputs(change.files);
  if (unqualified.length) {
    console.log(
      `Global inputs not qualified by local test selection:\n${unqualified.map((file) => `  ${file}`).join("\n")}`,
    );
  }
  if (list) {
    console.log(listPlan(steps).join("\n"));
    return;
  }
  if (!steps.length) {
    console.log("No checks selected for this delta.");
    return;
  }
  process.exitCode = await HeavyweightLock.withHeavyweightLock(
    (lease) => {
      const previous = process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
      process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = lease.token;
      try {
        return runPlan(steps);
      } finally {
        if (previous === undefined) delete process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
        else process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = previous;
      }
    },
    { timeoutMs: HeavyweightLock.heavyweightLockTimeoutMs() },
  );
}

// Verification planning and checks do not need the Effect-backed process supervisor.
async function runSupervisedNode(args) {
  const supervisor = await import("./run-supervised-node.mjs");
  return supervisor.runSupervisedNode(args);
}

async function main([command, ...args]) {
  switch (command) {
    case "verify":
      return verify(args);
    case "full":
      // Reject obsolete inspection flags before a broad pipeline can allocate work.
      parseArgs({ args, options: {} });
      return runSupervisedNode(["--heavyweight", "--command", "nub", "run", "verify:integration"]);
    default:
      throw new Error("usage: node scripts/dev.mjs <verify|full> [args...]");
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  const signal = osConstants.signals[error?.signal];
  process.exitCode = signal ? 128 + signal : (error?.status ?? 1);
}
