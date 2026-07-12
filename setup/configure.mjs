#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { deriveSetupPolicyEffect } from "./policy-effect.mjs";
import { configurePiEffect } from "./pi-config.mjs";
import { configureRepoToolsEffect } from "./repo-tools.mjs";
import { configureTerminalToolsEffect } from "./terminal-config.mjs";
import {
  renderSetupError,
  setupErrorExitCode,
  SetupCommandExitError,
  SetupCommandStartError,
  SetupEnvError,
  SetupUsageError,
} from "./setup-errors.mjs";

const ConfigureCommand = Object.freeze({
  All: "all",
  Pi: "pi",
  Terminal: "terminal",
  RepoTools: "repo-tools",
});

const command = process.argv[2] || ConfigureCommand.All;
const setupNodeBin = process.argv[3] || process.execPath;
const env = process.env;

function envEffect(name) {
  const value = env[name];
  return value ? Effect.succeed(value) : Effect.fail(new SetupEnvError(name));
}

function makeRun(repo) {
  return function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: options.cwd ?? repo,
      env,
      stdio: options.stdio ?? "pipe",
      encoding: "utf8",
    });
    if (result.error) throw new SetupCommandStartError(command, args, result.error);
    if (result.status !== 0 && options.check !== false) {
      throw new SetupCommandExitError(command, args, result.status, result.stderr);
    }
    return result;
  };
}

function ctxEffect() {
  return Effect.gen(function* () {
    const repo = yield* envEffect("REPO");
    return Object.freeze({
      env,
      run: makeRun(repo),
      setupNodeBin,
      repo,
      setupDir: yield* envEffect("SETUP_DIR"),
      settingsFile: yield* envEffect("SETTINGS_FILE"),
      managedSettingsFile: yield* envEffect("MANAGED_SETTINGS_FILE"),
      agentsDir: yield* envEffect("AGENTS_DIR"),
      testUtilsDir: yield* envEffect("TEST_UTILS_DIR"),
      appendSrc: yield* envEffect("APPEND_SRC"),
      appendDst: yield* envEffect("APPEND_DST"),
      appendMarker: yield* envEffect("APPEND_MARKER"),
      piAgentDir: yield* envEffect("PI_AGENT_DIR"),
      tmuxConf: yield* envEffect("TMUX_CONF"),
      tmuxSourceLine: yield* envEffect("TMUX_SOURCE_LINE"),
      ghosttyConfigDir: yield* envEffect("GHOSTTY_CONFIG_DIR"),
      postMergeHookSrc: yield* envEffect("POST_MERGE_HOOK_SRC"),
      preCommitHookSrc: yield* envEffect("PRE_COMMIT_HOOK_SRC"),
    });
  });
}

function configureEffect() {
  return Effect.gen(function* () {
    const ctx = yield* ctxEffect();
    const policy = yield* deriveSetupPolicyEffect(env);
    switch (command) {
      case ConfigureCommand.All:
        yield* configurePiEffect(ctx, policy);
        yield* configureTerminalToolsEffect(ctx, policy);
        yield* configureRepoToolsEffect(ctx, policy);
        break;
      case ConfigureCommand.Pi:
        yield* configurePiEffect(ctx, policy);
        break;
      case ConfigureCommand.Terminal:
        yield* configureTerminalToolsEffect(ctx, policy);
        break;
      case ConfigureCommand.RepoTools:
        yield* configureRepoToolsEffect(ctx, policy);
        break;
      default:
        yield* Effect.fail(new SetupUsageError(`unknown configure command: ${command}`, 2));
    }
  });
}

NodeRuntime.runMain(
  configureEffect().pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(renderSetupError(error));
        process.exitCode = setupErrorExitCode(error);
      }),
    ),
  ),
);
