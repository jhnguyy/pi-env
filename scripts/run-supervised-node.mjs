import { Effect, Result } from "effect";
import {
  DEFAULT_KILL_GRACE_MS,
  ProcessFailureKind,
  resolveNodeCommand,
  runInheritedProcess,
} from "../src/process/platform.ts";

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 };

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.error(`${name} must be a positive integer.`);
  process.exitCode = 2;
  return null;
}

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error("usage: scripts/run-supervised-node.mjs <script> [args...]");
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

    try {
      const result = await Effect.runPromise(
        Effect.result(
          runInheritedProcess(resolveNodeCommand(), [script, ...args], {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            killGraceMs,
          }),
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
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  }
}
