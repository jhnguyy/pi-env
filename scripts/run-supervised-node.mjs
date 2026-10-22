import { Effect, Result } from "effect";
import {
  DEFAULT_KILL_GRACE_MS,
  ProcessFailureKind,
  resolveNodeCommand,
  runInheritedProcess,
} from "../src/process/platform.ts";

import {
  acquireHeavyweightLock,
  gitCommonDir,
  heavyweightLockTimeoutMs,
} from "./heavyweight-lock.mjs";

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 };

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.error(`${name} must be a positive integer.`);
  process.exitCode = 2;
  return null;
}

const commandArgs = process.argv.slice(2);
const heavyweight = commandArgs[0] === "--heavyweight";
if (heavyweight) commandArgs.shift();
const externalCommand = commandArgs[0] === "--command";
if (externalCommand) commandArgs.shift();
const [script, ...args] = commandArgs;

function normalizeVitestWorkerArgs(scriptPath, commandArgs) {
  if (!scriptPath.endsWith("/vitest.mjs")) return commandArgs;

  const normalized = [];
  let maxWorkers;
  for (let index = 0; index < commandArgs.length; index++) {
    const argument = commandArgs[index];
    if (argument.startsWith("--maxWorkers=")) {
      maxWorkers = argument;
      continue;
    }
    if (argument === "--maxWorkers" && index + 1 < commandArgs.length) {
      maxWorkers = `--maxWorkers=${commandArgs[++index]}`;
      continue;
    }
    normalized.push(argument);
  }
  return maxWorkers === undefined ? normalized : [...normalized, maxWorkers];
}

if (!script) {
  console.error(
    "usage: scripts/run-supervised-node.mjs [--heavyweight] [--command] <script-or-command> [args...]",
  );
  process.exitCode = 2;
} else {
  const timeoutMs = positiveInteger(
    process.env.PI_ENV_TEST_TIMEOUT_MS,
    undefined,
    "PI_ENV_TEST_TIMEOUT_MS",
  );
  const killGraceMs = positiveInteger(
    process.env.PI_ENV_TEST_KILL_GRACE_MS,
    DEFAULT_KILL_GRACE_MS,
    "PI_ENV_TEST_KILL_GRACE_MS",
  );

  if (timeoutMs !== null && killGraceMs !== null) {
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

    let lease;
    try {
      const commonDir = heavyweight
        ? gitCommonDir(process.cwd(), { allowMissing: true })
        : undefined;
      if (commonDir) {
        lease = await acquireHeavyweightLock({
          commonDir,
          timeoutMs: heavyweightLockTimeoutMs(),
          signal: controller.signal,
          onWait: (owner) =>
            console.error(
              `Waiting for heavyweight-operation lock${owner ? ` (held by pid ${owner.pid})` : ""}.`,
            ),
        });
      }
      const result = await Effect.runPromise(
        Effect.result(
          runInheritedProcess(
            externalCommand ? script : resolveNodeCommand(),
            externalCommand ? args : [script, ...normalizeVitestWorkerArgs(script, args)],
            {
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(lease
                ? { env: { ...process.env, PI_ENV_HEAVYWEIGHT_LOCK_TOKEN: lease.token } }
                : {}),
              killGraceMs,
            },
          ),
        ),
        { signal: controller.signal },
      );
      if (Result.isSuccess(result)) {
        process.exitCode = result.success;
      } else {
        console.error(result.failure.message);
        process.exitCode = result.failure.kind === ProcessFailureKind.Timeout ? 124 : 1;
      }
    } catch (error) {
      if (receivedSignal) {
        process.exitCode = SIGNAL_EXIT_CODE[receivedSignal];
      } else {
        throw error;
      }
    } finally {
      try {
        await lease?.release();
      } finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      }
    }
  }
}
