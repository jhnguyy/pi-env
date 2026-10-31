#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as HeavyweightLock from "./heavyweight-lock.mjs";
import { changedFiles } from "./changed-files.mjs";
import { runSupervisedNode } from "./run-supervised-node.mjs";
import {
  changedVerificationPlan,
  EXPLICIT_VERIFICATION_PHASES,
  FULL_VERIFICATION_PHASES,
  verificationPhaseById,
} from "./verification-phases.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

const repo = resolve(import.meta.dirname, "..");
function capture(command, args, cwd = process.cwd()) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

async function runDockerTests(args) {
  process.env.PI_ENV_REVISION = capture("git", ["describe", "--always", "--dirty", "--abbrev=40"]);
  await runSupervisedNode([
    "--command",
    "docker",
    "buildx",
    "bake",
    "session-manager-e2e-evidence",
  ]);
  if (!process.exitCode)
    await runSupervisedNode([
      "--command",
      "docker",
      "buildx",
      "bake",
      "session-manager-e2e",
      ...args,
    ]);
}

function lintArguments(args) {
  return [
    "--command",
    join(repo, "scripts/tool-node-run.sh"),
    join(repo, "node_modules/oxlint/bin/oxlint"),
    ".",
    "--type-aware",
    "--threads=1",
    "--deny-warnings",
    "--ignore-pattern",
    "tests/**",
    "--ignore-pattern",
    "**/dist/**",
    ...args,
  ];
}
function typecheckArguments(args) {
  const compiler = capture(
    process.execPath,
    [join(repo, "node_modules/@effect/tsgo/dist/effect-tsgo.cjs"), "get-exe-path"],
    repo,
  );
  return ["--command", compiler, ...args];
}

function verificationPlan(args) {
  if (args[0] === "phase") {
    if (args.length === 2 && args[1] === "--list") return EXPLICIT_VERIFICATION_PHASES;
    if (args.length !== 2) throw new Error("usage: nub run verify:phase <phase-id> | --list");
    const selected = verificationPhaseById(args[1]);
    if (!selected) throw new Error(`Unknown verification phase: ${args[1]}`);
    return [selected];
  }
  const {
    values: { full, base, "checks-only": checksOnly },
  } = parseArgs({
    args,
    options: {
      full: { type: "boolean" },
      "checks-only": { type: "boolean" },
      list: { type: "boolean" },
      base: { type: "string" },
    },
  });
  if (full) {
    if (checksOnly || base)
      throw new Error("--full cannot be combined with --checks-only or --base");
    console.log("Verification scope: complete repository (explicit full verification).");
    return FULL_VERIFICATION_PHASES;
  }
  const change = changedFiles({ base });
  console.log(`Verification scope: ${change.files.length} changed paths since ${change.base}.`);
  console.log(
    "Full type analysis, packaging and complete coverage remain the CI/verify:full gate.",
  );
  return changedVerificationPlan(change, { checksOnly });
}

async function runVerification(args) {
  const phases = verificationPlan(args);
  if (args.includes("--list")) {
    console.log(listPlan(phases).join("\n"));
    return;
  }
  if (!phases.length) {
    console.log("No checks selected for this delta.");
    return;
  }
  const commonDir = HeavyweightLock.gitCommonDir(process.cwd(), { allowMissing: true });
  const execute = () => runPlan(phases, { name: "verify" });
  process.exitCode = commonDir
    ? await HeavyweightLock.withHeavyweightLock(
        (lease) => {
          const previous = process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
          process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = lease.token;
          try {
            return execute();
          } finally {
            if (previous === undefined) delete process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
            else process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = previous;
          }
        },
        { timeoutMs: HeavyweightLock.heavyweightLockTimeoutMs() },
      )
    : execute();
}

async function main([command, ...args]) {
  if (command === "verify") return runVerification(args);
  if (command === "test:docker") return runDockerTests(args);
  let commandArgs;
  switch (command) {
    case "test": {
      const [mode, ...rest] = args;
      commandArgs = [
        join(repo, "node_modules/vitest/vitest.mjs"),
        ...(mode === "related" ? ["related", "--run", ...rest] : ["--run", ...args]),
      ];
      break;
    }
    case "lint":
      commandArgs = lintArguments(args);
      break;
    case "typecheck":
      commandArgs = typecheckArguments(args);
      break;
    default:
      throw new Error(
        "usage: node scripts/dev.mjs <test|test:docker|verify|lint|typecheck> [args...]",
      );
  }
  await runSupervisedNode(["--heavyweight", ...commandArgs]);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  const signal = osConstants.signals[error?.signal];
  process.exitCode = signal ? 128 + signal : (error?.status ?? 1);
}
