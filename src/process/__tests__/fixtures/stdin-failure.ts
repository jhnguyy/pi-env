import { Effect, Result } from "effect";
import { runProcess, streamProcess } from "../../platform.ts";

// Keep an unhandled stdin error confined to this caller, not the test runner.
const execute = process.argv[2] === "stream" ? streamProcess : runProcess;
const result = await Effect.runPromise(
  Effect.result(
    execute(
      process.execPath,
      ["-e", "require('node:fs').closeSync(0); setTimeout(() => process.exit(0), 100)"],
      { stdin: "x".repeat(4 * 1024 * 1024), timeoutMs: 5_000, killGraceMs: 50 },
    ),
  ),
);
if (Result.isFailure(result)) console.log(result.failure.kind);
else throw new Error("Expected rejected stdin delivery, even if the child exits zero");
