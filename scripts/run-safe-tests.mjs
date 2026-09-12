#!/usr/bin/env node
import { Effect, Result } from "effect";
import { runInheritedProcess, runProcess } from "../src/process/platform.ts";

const DEFAULT_UNIT_BATCH_SIZE = 16;
const DEFAULT_INTEGRATION_BATCH_SIZE = 4;
const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 };

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

async function testFiles(portfolio) {
  const result = await Effect.runPromise(
    runProcess("scripts/node-run.sh", ["node_modules/vitest/vitest.mjs", "list", "--filesOnly"], {
      env: { ...process.env, PI_ENV_TEST_PORTFOLIO: portfolio },
    }),
    { signal: controller.signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Vitest discovery exited with ${result.exitCode}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

try {
  const batchSizes = {
    unit: positiveInteger(process.env.PI_ENV_SAFE_TEST_BATCH_SIZE, DEFAULT_UNIT_BATCH_SIZE),
    integration: positiveInteger(
      process.env.PI_ENV_SAFE_INTEGRATION_BATCH_SIZE,
      DEFAULT_INTEGRATION_BATCH_SIZE,
    ),
  };
  const groups = [];
  for (const portfolio of ["unit", "integration"]) {
    groups.push({ portfolio, files: await testFiles(portfolio) });
  }
  const plan = groups.flatMap(({ portfolio, files }) =>
    batches(files, batchSizes[portfolio]).map((batch, index) => ({
      portfolio,
      index: index + 1,
      total: Math.ceil(files.length / batchSizes[portfolio]),
      files: batch,
    })),
  );

  if (process.argv.includes("--list")) {
    for (const batch of plan) {
      console.log(`${batch.portfolio} ${batch.index}/${batch.total}: ${batch.files.join(" ")}`);
    }
  } else {
    for (const batch of plan) {
      console.log(`\n==> ${batch.portfolio} test batch ${batch.index}/${batch.total}`);
      const result = await Effect.runPromise(
        Effect.result(
          runInheritedProcess("nub", ["run", "test:vitest", "--maxWorkers=1", ...batch.files], {
            env: { ...process.env, PI_ENV_TEST_PORTFOLIO: batch.portfolio },
          }),
        ),
        { signal: controller.signal },
      );
      if (Result.isFailure(result)) {
        console.error(result.failure.message);
        process.exitCode = 1;
        break;
      }
      if (result.success !== 0) {
        process.exitCode = result.success;
        break;
      }
    }
  }
} catch (error) {
  if (receivedSignal) process.exitCode = SIGNAL_EXIT_CODE[receivedSignal];
  else throw error;
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
