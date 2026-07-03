#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RuntimeCommand,
  commandSucceeds,
  fail,
  mustEnv,
  ok,
  parseRuntimeCommand,
  run,
  runChecked,
  section,
  skip,
} from './runtime-support.mjs';

const PiPackage = Object.freeze({
  Name: '@earendil-works/pi-coding-agent',
  Entry: 'dist/cli.js',
});

const repo = mustEnv('REPO');
const piBinDir = mustEnv('PI_BIN_DIR');
const setupNodeBin = process.argv[2] || process.execPath;
const command = parseRuntimeCommand(process.argv[3]);

function nubNeedsPlainNode() {
  if (commandSucceeds('nub', ['run', '--silent', 'check:node'], { cwd: repo })) return false;
  return commandSucceeds('nub', ['run', '--node', '--ignore-scripts', '--silent', 'check:node'], { cwd: repo });
}

function nubInstall(args) {
  return run('nub', ['install', ...args, '--frozen-lockfile'], { cwd: repo }).status === 0;
}

function installDependencies() {
  section('Dependencies');
  console.log('  —  installing repo dependencies with nub');

  if (nubNeedsPlainNode()) {
    console.log('  —  nub runtime augmentation cannot execute Node here; using plain Node for setup scripts.');
    if (!nubInstall(['--ignore-scripts'])) {
      console.log('  —  nub install failed; removing node_modules and retrying once.');
      rmSync(join(repo, 'node_modules'), { recursive: true, force: true });
      if (!nubInstall(['--ignore-scripts'])) fail('  ✗  nub install failed after retry');
    }
    runChecked('sh', ['scripts/restart-lsp-daemon.sh'], { cwd: repo });
    runChecked(setupNodeBin, ['scripts/build-extensions.mjs'], { cwd: repo });
  } else {
    if (!nubInstall([])) {
      console.log('  —  nub install failed; removing node_modules and retrying once.');
      rmSync(join(repo, 'node_modules'), { recursive: true, force: true });
      if (!nubInstall([])) fail('  ✗  nub install failed after retry');
    }
    runChecked('nub', ['run', 'build'], { cwd: repo });
  }

  ok('node_modules up to date');
}

function readPiVersion() {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  return pkg.devDependencies?.[PiPackage.Name]
    ?? pkg.dependencies?.[PiPackage.Name];
}

function shSingleQuote(value) {
  return String(value).replaceAll("'", "'\\''");
}

function writePiWrapper(piPackageDir) {
  mkdirSync(piBinDir, { recursive: true });
  const wrapper = `#!/usr/bin/env sh
set -eu

DEFAULT_PI_PACKAGE_DIR='${shSingleQuote(piPackageDir)}'
REQUESTED_PI_PACKAGE_DIR="\${PI_PACKAGE_DIR:-}"
PI_PACKAGE_DIR="$DEFAULT_PI_PACKAGE_DIR"

if [ -n "$REQUESTED_PI_PACKAGE_DIR" ] && [ -f "$REQUESTED_PI_PACKAGE_DIR/package.json" ] && [ -f "$REQUESTED_PI_PACKAGE_DIR/${PiPackage.Entry}" ]; then
  PI_PACKAGE_DIR="$REQUESTED_PI_PACKAGE_DIR"
fi

PI_ENTRY="$PI_PACKAGE_DIR/${PiPackage.Entry}"
NODE_BIN='${shSingleQuote(setupNodeBin)}'

if [ ! -x "$NODE_BIN" ]; then
  echo "pi-env: configured Node is not executable: $NODE_BIN" >&2
  echo "pi-env: rerun setup through nix run .#setup or set PI_ENV_NODE_BIN before setup." >&2
  exit 127
fi

if [ ! -f "$PI_PACKAGE_DIR/package.json" ] || [ ! -f "$PI_ENTRY" ]; then
  echo "pi-env: missing pi package install at $PI_PACKAGE_DIR" >&2
  echo "pi-env: rerun setup.sh, or set PI_PACKAGE_DIR to a valid pi package directory." >&2
  exit 127
fi

exec "$NODE_BIN" "$PI_ENTRY" "$@"
`;
  const piPath = join(piBinDir, 'pi');
  writeFileSync(piPath, wrapper, { mode: 0o755 });
}

function profileHasPathEntry(profile, binDir, marker) {
  if (!existsSync(profile)) return false;
  const content = readFileSync(profile, 'utf8');
  if (content.includes(marker)) return true;
  if (content.includes(binDir) && content.includes('PATH')) return true;
  if (binDir === `${process.env.HOME}/.local/bin` && /(\$HOME|~)\/\.local\/bin/.test(content) && content.includes('PATH')) return true;
  return false;
}

function ensurePathInShellProfiles(binDir) {
  const marker = '# pi-env: add user-local bin to PATH';
  const home = process.env.HOME;
  const profiles = [`${home}/.zshrc`, `${home}/.bashrc`, `${home}/.profile`];
  let configured = false;
  const existingProfiles = [];

  for (const profile of profiles) {
    if (profileHasPathEntry(profile, binDir, marker)) {
      ok(`${profile} already configures ${binDir}`);
      configured = true;
    } else if (existsSync(profile)) {
      existingProfiles.push(profile);
    }
  }

  const targets = existingProfiles.length === 0 && !configured ? [`${home}/.profile`] : existingProfiles;
  for (const profile of targets) {
    const pathExpr = binDir === `${home}/.local/bin`
      ? 'export PATH="$HOME/.local/bin:$PATH"'
      : `export PATH="${binDir}:$PATH"`;
    mkdirSync(dirname(profile), { recursive: true });
    const existed = existsSync(profile);
    const prefix = existed ? '\n' : '';
    writeFileSync(profile, `${prefix}${marker}\n${pathExpr}\n`, { flag: 'a' });
    ok(`${profile} (${existed ? 'appended' : 'created'} PATH entry)`);
  }
}

function installPiCli() {
  section('Pi CLI');

  const version = readPiVersion();
  const piPackageDir = join(repo, 'node_modules', ...PiPackage.Name.split('/'));
  const piEntry = join(piPackageDir, PiPackage.Entry);

  if (!existsSync(join(piPackageDir, 'package.json'))) {
    fail(`  ✗  missing pi package after install: ${piPackageDir}`);
  }
  if (!existsSync(piEntry)) {
    fail(`  ✗  missing pi entrypoint after install: ${piEntry}`);
  }

  if (process.env.PI_ENV_CLI_MANAGED_BY_NIX === '1') {
    ok(`pi ${version} package installed (CLI wrapper managed externally)`);
    return;
  }

  writePiWrapper(piPackageDir);
  ok(`pi ${version} → ${join(piBinDir, 'pi')}`);

  if (process.env.PI_ENV_SETUP_MODE === 'nix-managed'
      || process.env.PI_ENV_CONFIG_MANAGED_BY_NIX === '1'
      || process.env.PI_ENV_SKIP_PATH_PROFILE === '1') {
    skip('shell profile PATH edits (managed externally)');
  } else if (!process.env.PATH.split(':').includes(piBinDir)) {
    console.log(`  —  ${piBinDir} is not in PATH yet; updating shell profiles.`);
    ensurePathInShellProfiles(piBinDir);
  }
}

switch (command) {
  case RuntimeCommand.All:
    installDependencies();
    installPiCli();
    break;
  case RuntimeCommand.PiCli:
    installPiCli();
    break;
  default:
    fail(`unknown runtime setup command: ${command}`, 2);
}
