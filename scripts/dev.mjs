#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { join, relative, resolve } from "node:path";
import { Effect, Result } from "effect";
import { runInheritedProcess, runProcess } from "../src/process/platform.ts";
import * as HeavyweightLock from "./heavyweight-lock.mjs";
import { runSupervisedNode } from "./run-supervised-node.mjs";
import {
  EXPLICIT_VERIFICATION_PHASES,
  PRE_COMMIT_VERIFICATION_PHASES,
  SAFE_VERIFICATION_PHASES,
  STANDARD_VERIFICATION_PHASES,
  verificationPhaseById,
} from "./verification-phases.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

const repo = resolve(import.meta.dirname, "..");
const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 };

function capture(command, args, cwd = process.cwd()) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

async function runTests(mode, args) {
  switch (mode) {
    case "all":
      break;
    case "unit":
    case "integration":
      process.env.PI_ENV_TEST_PORTFOLIO = mode;
      break;
    case "e2e":
      process.env.E2E = "1";
      break;
    case "safe":
      await runSafeTests(args);
      return;
    case "docker":
      await runDockerTests(args);
      return;
    default:
      console.error(`Unknown test mode: ${mode ?? "(missing)"}`);
      process.exitCode = 2;
      return;
  }
  const command = args[0] === "list" ? args.shift() : "run";
  await runSupervisedNode([
    "--heavyweight",
    join(repo, "node_modules/vitest/vitest.mjs"),
    command,
    ...args,
  ]);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function batches(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function testFiles(portfolio, signal) {
  const result = await Effect.runPromise(
    runProcess("nub", ["run", "test", "list", "--filesOnly", "--json"], {
      env: { ...process.env, PI_ENV_TEST_PORTFOLIO: portfolio },
    }),
    { signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Vitest discovery exited with ${result.exitCode}`);
  }
  const entries = JSON.parse(result.stdout);
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) => !entry || typeof entry.file !== "string" || entry.projectName !== portfolio,
    )
  ) {
    throw new Error(`Invalid Vitest discovery for ${portfolio}`);
  }
  return entries.map((entry) => relative(process.cwd(), entry.file)).sort();
}

async function safeTestPlan(signal) {
  const batchSizes = {
    unit: positiveInteger(process.env.PI_ENV_SAFE_TEST_BATCH_SIZE, 16),
    integration: positiveInteger(process.env.PI_ENV_SAFE_INTEGRATION_BATCH_SIZE, 4),
  };
  const groups = [];
  for (const portfolio of ["unit", "integration"]) {
    groups.push({ portfolio, files: await testFiles(portfolio, signal) });
  }
  return groups.flatMap(({ portfolio, files }) =>
    batches(files, batchSizes[portfolio]).map((batch, index) => ({
      portfolio,
      index: index + 1,
      total: Math.ceil(files.length / batchSizes[portfolio]),
      files: batch,
    })),
  );
}

async function runTestBatches(plan, signal) {
  for (const batch of plan) {
    console.log(`\n==> ${batch.portfolio} test batch ${batch.index}/${batch.total}`);
    const result = await Effect.runPromise(
      Effect.result(
        runInheritedProcess("nub", ["run", "test", "--maxWorkers=1", ...batch.files], {
          env: { ...process.env, PI_ENV_TEST_PORTFOLIO: batch.portfolio },
        }),
      ),
      { signal },
    );
    if (Result.isFailure(result)) {
      console.error(result.failure.message);
      return 1;
    }
    if (result.success !== 0) return result.success;
  }
  return 0;
}

async function runSafeTests(args) {
  const controller = new AbortController();
  let receivedSignal;
  const interrupt = (signal) => {
    receivedSignal ??= signal;
    controller.abort();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    const plan = await safeTestPlan(controller.signal);
    if (args.includes("--list")) {
      for (const batch of plan) {
        console.log(`${batch.portfolio} ${batch.index}/${batch.total}: ${batch.files.join(" ")}`);
      }
    } else {
      process.exitCode = await runTestBatches(plan, controller.signal);
    }
  } catch (error) {
    if (receivedSignal) process.exitCode = SIGNAL_EXIT_CODE[receivedSignal];
    else throw error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
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
  if (process.exitCode) return;
  await runSupervisedNode([
    "--command",
    "docker",
    "buildx",
    "bake",
    "session-manager-e2e",
    ...args,
  ]);
}

async function runLint(args) {
  await runSupervisedNode([
    "--heavyweight",
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
  ]);
}

async function runTypecheck(args) {
  const compiler = capture(
    process.execPath,
    [join(repo, "node_modules/@effect/tsgo/dist/effect-tsgo.cjs"), "get-exe-path"],
    repo,
  );
  await runSupervisedNode(["--heavyweight", "--command", compiler, ...args]);
}

function verificationPhases(mode) {
  switch (mode) {
    case "standard":
      return STANDARD_VERIFICATION_PHASES;
    case "safe":
      return SAFE_VERIFICATION_PHASES;
    case "pre-commit":
      return PRE_COMMIT_VERIFICATION_PHASES;
    case "phase":
      return EXPLICIT_VERIFICATION_PHASES;
  }
}

async function runVerification(mode, args) {
  const phases = verificationPhases(mode);
  if (!phases) {
    console.error(`Unknown verification mode: ${mode ?? "(missing)"}`);
    process.exitCode = 2;
    return;
  }
  if (args.includes("--list")) {
    console.log(listPlan(phases).join("\n"));
    return;
  }
  if (mode === "phase") {
    runVerificationPhase(args);
    return;
  }
  const name = mode === "standard" ? "verify" : `verify:${mode}`;
  if (mode !== "safe") {
    process.exitCode = runPlan(phases, { name });
    return;
  }
  process.exitCode = await HeavyweightLock.withHeavyweightLock(
    (lease) => {
      const inheritedToken = process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
      process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = lease.token;
      try {
        return runPlan(phases, { name });
      } finally {
        if (inheritedToken === undefined) delete process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
        else process.env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN = inheritedToken;
      }
    },
    { timeoutMs: HeavyweightLock.heavyweightLockTimeoutMs() },
  );
}

function runVerificationPhase(args) {
  if (args.length !== 1) {
    console.error("usage: nub run verify:phase <phase-id> | --list");
    process.exitCode = 2;
    return;
  }
  const phase = verificationPhaseById(args[0]);
  if (!phase) {
    const expected = EXPLICIT_VERIFICATION_PHASES.map((candidate) => candidate.id).join(", ");
    console.error(
      `verify:phase: unknown phase ${JSON.stringify(args[0])}; expected one of: ${expected}`,
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = runPlan([phase], { name: "verify:phase" });
}

async function main([command, ...args]) {
  switch (command) {
    case "test":
      await runTests(args[0], args.slice(1));
      return;
    case "verify":
      await runVerification(args[0], args.slice(1));
      return;
    case "lint":
      await runLint(args);
      return;
    case "typecheck":
      await runTypecheck(args);
      return;
    default:
      console.error("usage: node scripts/dev.mjs <test|verify|lint|typecheck> [mode] [args...]");
      process.exitCode = 2;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  const signal = osConstants.signals[error?.signal];
  process.exitCode = signal ? 128 + signal : (error?.status ?? 1);
}
