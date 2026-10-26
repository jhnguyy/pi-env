import { Effect, Result } from "effect";
import * as Process from "../src/process/platform.ts";
import * as HeavyweightLock from "./heavyweight-lock.mjs";

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 };

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.error(`${name} must be a positive integer.`);
  process.exitCode = 2;
  return null;
}

async function runSupervisedCommand(command, args, heavyweight, timeoutMs, killGraceMs) {
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
      ? HeavyweightLock.gitCommonDir(process.cwd(), { allowMissing: true })
      : undefined;
    if (commonDir) {
      lease = await HeavyweightLock.acquireHeavyweightLock({
        commonDir,
        timeoutMs: HeavyweightLock.heavyweightLockTimeoutMs(),
        signal: controller.signal,
        onWait: (owner) =>
          console.error(
            `Waiting for heavyweight-operation lock${owner ? ` (held by pid ${owner.pid})` : ""}.`,
          ),
      });
    }
    const result = await Effect.runPromise(
      Effect.result(
        Process.runInheritedProcess(command, args, {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(lease ? { env: { ...process.env, PI_ENV_HEAVYWEIGHT_LOCK_TOKEN: lease.token } } : {}),
          killGraceMs,
        }),
      ),
      { signal: controller.signal },
    );
    if (Result.isSuccess(result)) {
      process.exitCode = result.success;
    } else {
      console.error(result.failure.message);
      process.exitCode = result.failure.kind === Process.ProcessFailureKind.Timeout ? 124 : 1;
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

export async function runSupervisedNode(commandArgs) {
  const heavyweight = commandArgs[0] === "--heavyweight";
  if (heavyweight) commandArgs.shift();
  const externalCommand = commandArgs[0] === "--command";
  if (externalCommand) commandArgs.shift();
  const [script, ...args] = commandArgs;

  if (!script) {
    console.error(
      "usage: scripts/run-supervised-node.mjs [--heavyweight] [--command] <script-or-command> [args...]",
    );
    process.exitCode = 2;
    return;
  }
  const timeoutMs = positiveInteger(
    process.env.PI_ENV_TEST_TIMEOUT_MS,
    undefined,
    "PI_ENV_TEST_TIMEOUT_MS",
  );
  const killGraceMs = positiveInteger(
    process.env.PI_ENV_TEST_KILL_GRACE_MS,
    Process.DEFAULT_KILL_GRACE_MS,
    "PI_ENV_TEST_KILL_GRACE_MS",
  );
  if (timeoutMs === null || killGraceMs === null) return;

  await runSupervisedCommand(
    externalCommand ? script : Process.resolveNodeCommand(),
    externalCommand ? args : [script, ...args],
    heavyweight,
    timeoutMs,
    killGraceMs,
  );
}

if (import.meta.main) {
  await runSupervisedNode(process.argv.slice(2));
}
