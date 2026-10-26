#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { fileEffect } from "./file-ops.mjs";
import { configureHomeManagerEffect } from "./home-manager.mjs";
import { configurePiEffect } from "./pi-config.mjs";
import { deriveSetupPolicy } from "./policy.mjs";
import { configureRepoToolsEffect } from "./repo-tools.mjs";
import { parseSetupContextEffect } from "./setup-context.mjs";
import { renderSetupError, setupErrorExitCode, SetupUsageError } from "./setup-errors.mjs";
import { configureTerminalToolsEffect } from "./terminal-config.mjs";

function recordHomeManagerEffect(ctx, policy) {
  return Effect.gen(function* () {
    const outcome = yield* configureHomeManagerEffect(ctx, policy);
    const outcomeFile = ctx.env.PI_ENV_HOME_MANAGER_OUTCOME_FILE;
    if (outcomeFile) {
      yield* fileEffect("record Home Manager outcome", outcomeFile, () =>
        writeFileSync(outcomeFile, outcome),
      );
    }
  });
}

const Commands = Object.freeze({
  all: [configurePiEffect, configureTerminalToolsEffect, configureRepoToolsEffect],
  pi: [configurePiEffect],
  terminal: [configureTerminalToolsEffect],
  "repo-tools": [configureRepoToolsEffect],
  "home-manager": [recordHomeManagerEffect],
});

function configureEffect(command, setupNodeBin, env) {
  return Effect.gen(function* () {
    if (!Object.hasOwn(Commands, command)) {
      return yield* Effect.fail(new SetupUsageError(`unknown configure command: ${command}`, 2));
    }
    const ctx = yield* parseSetupContextEffect(env, setupNodeBin);
    const policy = deriveSetupPolicy(env);
    for (const step of Commands[command]) yield* step(ctx, policy);
  });
}

NodeRuntime.runMain(
  configureEffect(process.argv[2] || "all", process.argv[3] || process.execPath, process.env).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(renderSetupError(error));
        process.exitCode = setupErrorExitCode(error);
      }),
    ),
  ),
);
