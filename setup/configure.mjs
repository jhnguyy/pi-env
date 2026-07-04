#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail, mustEnv, ok, section, skip } from './runtime-support.mjs';
import { isNixManaged } from './ownership.mjs';

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
const setupDir = mustEnv('SETUP_DIR');
const settingsFile = mustEnv('SETTINGS_FILE');
const managedSettingsFile = mustEnv('MANAGED_SETTINGS_FILE');
const agentsDir = mustEnv('AGENTS_DIR');
const testUtilsDir = mustEnv('TEST_UTILS_DIR');
const appendSrc = mustEnv('APPEND_SRC');
const appendDst = mustEnv('APPEND_DST');
const appendMarker = mustEnv('APPEND_MARKER');
const piAgentDir = mustEnv('PI_AGENT_DIR');
const tmuxConf = mustEnv('TMUX_CONF');
const tmuxSourceLine = mustEnv('TMUX_SOURCE_LINE');
const ghosttyConfigDir = mustEnv('GHOSTTY_CONFIG_DIR');
const postMergeHookSrc = mustEnv('POST_MERGE_HOOK_SRC');
const preCommitHookSrc = mustEnv('PRE_COMMIT_HOOK_SRC');

function linked(message) { console.log(`  →  ${message}`); }
function relink(message) { console.log(`  ↺  ${message} (relinked)`); }

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

function bootstrapFile(src, dst, existsLabel, createdLabel) {
  if (existsSync(dst)) {
    ok(existsLabel);
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    ok(createdLabel);
  }
}

function linkPath(src, target, label) {
  if (pathExistsOrIsSymlink(target)) {
    try {
      const current = readlink(target);
      if (current === src) {
        ok(label);
        return;
      }
      unlinkSync(target);
      symlinkSync(src, target);
      relink(label);
      return;
    } catch {
      skip(label);
      return;
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(src, target);
  linked(label);
}

function pathExistsOrIsSymlink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readlink(path) {
  return readlinkSync(path);
}

function appendOnce(src, dst, marker, label) {
  if (!existsSync(dst)) {
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, `${marker}\n`);
    appendFileSync(dst, readFileSync(src));
    ok(`${label} (created with repo block)`);
  } else if (readFileSync(dst, 'utf8').includes(marker)) {
    ok(`${label} (repo block already present)`);
  } else {
    appendFileSync(dst, `\n${marker}\n`);
    appendFileSync(dst, readFileSync(src));
    ok(`${label} (appended repo block)`);
  }
}

function applyManagedSettings() {
  const result = run(setupNodeBin, ['setup/apply-managed-settings.mjs', settingsFile, managedSettingsFile, repo], { cwd: repo }).stdout.trim();
  switch (result) {
    case 'unchanged': ok('managed settings and package registration'); break;
    case 'created': linked('settings.json created with managed settings and package registration'); break;
    case 'updated': linked('managed settings applied to settings.json'); break;
    default: if (result) console.log(result);
  }
}

function configurePi() {
  section('Pi');
  bootstrapFile(
    join(setupDir, 'templates/settings.json'),
    settingsFile,
    'settings.json (exists — not overwritten)',
    'settings.json ← setup/templates/settings.json (review and customize: defaultModel, permissionLevel)',
  );
  applyManagedSettings();

  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(testUtilsDir, { recursive: true });
  linkPath(join(repo, '.agents/roles'), join(agentsDir, 'roles'), '~/.agents/roles');
  linkPath(join(repo, '.pi/extensions/__tests__/test-utils.ts'), join(testUtilsDir, 'test-utils.ts'), '~/.pi/agent/extensions/__tests__/test-utils.ts');
  linkPath(join(repo, '.pi/extensions/__tests__/loader.test.ts'), join(testUtilsDir, 'loader.test.ts'), '~/.pi/agent/extensions/__tests__/loader.test.ts');

  appendOnce(appendSrc, appendDst, appendMarker, '~/.pi/agent/APPEND_SYSTEM.md');
  bootstrapFile(
    join(repo, 'AGENTS.md'),
    join(piAgentDir, 'AGENTS.md'),
    '~/.pi/agent/AGENTS.md (exists — not overwritten)',
    '~/.pi/agent/AGENTS.md (bootstrapped from repo — customize for your environment)',
  );
}

function configureTmux() {
  if (isNixManaged() || env.PI_ENV_SKIP_TMUX === '1') {
    skip('tmux config (managed externally)');
    return;
  }
  if (existsSync(tmuxConf) && readFileSync(tmuxConf, 'utf8').includes(tmuxSourceLine)) {
    ok('tmux-gruvbox.conf sourced from ~/.tmux.conf');
  } else if (existsSync(tmuxConf)) {
    appendFileSync(tmuxConf, `\n${tmuxSourceLine}\n`);
    linked('tmux-gruvbox.conf appended to ~/.tmux.conf');
  } else {
    writeFileSync(tmuxConf, `${tmuxSourceLine}\n`);
    linked('tmux-gruvbox.conf → new ~/.tmux.conf');
  }
}

function configureGhostty() {
  if (isNixManaged() || env.PI_ENV_SKIP_GHOSTTY === '1') {
    skip('~/.config/ghostty (managed externally)');
    return;
  }
  if (env.SHOULD_LINK_GHOSTTY !== '1') {
    skip(`~/.config/ghostty (not needed for ${env.CONTEXT_LABEL ?? 'this context'}; set PI_ENV_LINK_GHOSTTY=1 to force)`);
    return;
  }

  try {
    mkdirSync(join(ghosttyConfigDir, 'themes'), { recursive: true });
  } catch {
    skip(`~/.config/ghostty (cannot create ${ghosttyConfigDir})`);
    return;
  }

  linkPath(join(repo, 'ghostty/config'), join(ghosttyConfigDir, 'config'), '~/.config/ghostty/config');
  linkPath(join(repo, 'ghostty/themes/pi-env-gruvbox-dark'), join(ghosttyConfigDir, 'themes/pi-env-gruvbox-dark'), '~/.config/ghostty/themes/pi-env-gruvbox-dark');
  linkPath(join(repo, 'ghostty/themes/pi-env-gruvbox-light'), join(ghosttyConfigDir, 'themes/pi-env-gruvbox-light'), '~/.config/ghostty/themes/pi-env-gruvbox-light');
}

function configureTerminalTools() {
  section('Terminal tools');
  if (env.PI_ENV_SKIP_TERMINAL === '1') {
    skip('terminal tools (disabled by setup option)');
    return;
  }
  configureTmux();
  configureGhostty();
}

function installGitHook(name, src, gitCommonDir) {
  const dst = join(gitCommonDir, 'hooks', name);
  mkdirSync(dirname(dst), { recursive: true });
  if (pathExistsOrIsSymlink(dst)) {
    if (!lstatSync(dst).isSymbolicLink()) {
      skip(`${name} hook (custom hook already exists at .git/hooks/${name})`);
      return;
    }
    if (readlink(dst) === src) {
      ok(`${name} hook`);
      return;
    }
    unlinkSync(dst);
  }
  symlinkSync(src, dst);
  run('chmod', ['+x', src], { stdio: 'ignore' });
  linked(`${name} hook → setup/${name}`);
}

function gitPath(args) {
  return run('git', ['-C', repo, ...args], { stdio: 'pipe' }).stdout.trim();
}

function configureRepoTools() {
  section('Repo tools');
  if (env.PI_ENV_SKIP_REPO_HOOKS === '1') {
    skip('repo hooks (disabled by setup option)');
    return;
  }

  const gitDir = gitPath(['rev-parse', '--absolute-git-dir']);
  const gitCommonDir = gitPath(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (gitDir !== gitCommonDir) {
    skip('repo hooks (worktree checkout — run setup.sh in the primary checkout to update shared hooks)');
  } else {
    installGitHook('post-merge', postMergeHookSrc, gitCommonDir);
    installGitHook('pre-commit', preCommitHookSrc, gitCommonDir);
  }
}

switch (command) {
  case ConfigureCommand.All:
    configurePi();
    configureTerminalTools();
    configureRepoTools();
    break;
  case ConfigureCommand.Pi:
    configurePi();
    break;
  case ConfigureCommand.Terminal:
    configureTerminalTools();
    break;
  case ConfigureCommand.RepoTools:
    configureRepoTools();
    break;
  default:
    fail(`unknown configure command: ${command}`, 2);
}
