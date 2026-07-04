#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { Effect } from 'effect';
import { fail, mustEnv } from './runtime-support.mjs';
import { deriveSetupPolicyEffect } from './policy-effect.mjs';
import { configurePiEffect } from './pi-config.mjs';
import { configureRepoToolsEffect } from './repo-tools.mjs';
import { configureTerminalToolsEffect } from './terminal-config.mjs';

const ConfigureCommand = Object.freeze({
  All: 'all',
  Pi: 'pi',
  Terminal: 'terminal',
  RepoTools: 'repo-tools',
});

const command = process.argv[2] || ConfigureCommand.All;
const setupNodeBin = process.argv[3] || process.execPath;
const env = process.env;
const repo = mustEnv('REPO');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    env,
    stdio: options.stdio ?? 'pipe',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.check !== false) {
    fail(`${command} ${args.join(' ')} exited with ${result.status}: ${result.stderr ?? ''}`.trim(), result.status ?? 1);
  }
  return result;
}

const ctx = Object.freeze({
  env,
  run,
  setupNodeBin,
  repo,
  setupDir: mustEnv('SETUP_DIR'),
  settingsFile: mustEnv('SETTINGS_FILE'),
  managedSettingsFile: mustEnv('MANAGED_SETTINGS_FILE'),
  agentsDir: mustEnv('AGENTS_DIR'),
  testUtilsDir: mustEnv('TEST_UTILS_DIR'),
  appendSrc: mustEnv('APPEND_SRC'),
  appendDst: mustEnv('APPEND_DST'),
  appendMarker: mustEnv('APPEND_MARKER'),
  piAgentDir: mustEnv('PI_AGENT_DIR'),
  tmuxConf: mustEnv('TMUX_CONF'),
  tmuxSourceLine: mustEnv('TMUX_SOURCE_LINE'),
  ghosttyConfigDir: mustEnv('GHOSTTY_CONFIG_DIR'),
  postMergeHookSrc: mustEnv('POST_MERGE_HOOK_SRC'),
  preCommitHookSrc: mustEnv('PRE_COMMIT_HOOK_SRC'),
});

function configureEffect() {
  return Effect.gen(function* () {
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
        fail(`unknown configure command: ${command}`, 2);
    }
  });
}

await Effect.runPromise(configureEffect());
