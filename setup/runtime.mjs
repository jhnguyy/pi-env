#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  RuntimeCommand,
  commandSucceeds,
  fail,
  mustEnv,
  ok,
  run,
  runChecked,
  section,
  skip,
} from "./runtime-support.mjs";
import { deriveSetupPolicy } from "./policy.mjs";
import { reconcileManagedBlock } from "./managed-block.mjs";

const PiPackage = Object.freeze({
  Name: "@earendil-works/pi-coding-agent",
  Bin: "pi",
});

const InstallStrategy = Object.freeze({
  NubManaged: "nub-managed",
  PlainNodeBootstrap: "plain-node-bootstrap",
});

const repo = mustEnv("REPO");
const piBinDir = mustEnv("PI_BIN_DIR");
const setupNodeBin = process.argv[2] || process.execPath;
const command = process.argv[3];

function selectInstallStrategy() {
  if (commandSucceeds("nub", ["run", "--no-check", "--silent", "check:node"], { cwd: repo }))
    return InstallStrategy.NubManaged;
  if (
    commandSucceeds(
      "nub",
      ["run", "--no-check", "--node", "--ignore-scripts", "--silent", "check:node"],
      { cwd: repo },
    )
  ) {
    return InstallStrategy.PlainNodeBootstrap;
  }
  return InstallStrategy.NubManaged;
}

function nubInstall(args) {
  return run("nub", ["install", ...args, "--frozen-lockfile"], { cwd: repo }).status === 0;
}

function installDependencies() {
  section("Dependencies");
  console.log("  —  Setup will install repository dependencies with Nub.");
  const strategy = selectInstallStrategy();
  const installArgs = strategy === InstallStrategy.PlainNodeBootstrap ? ["--ignore-scripts"] : [];
  if (!nubInstall(installArgs)) fail("  ✗  Nub install failed.");
  if (strategy === InstallStrategy.PlainNodeBootstrap) {
    runChecked(setupNodeBin, ["scripts/hydrate.mjs", setupNodeBin], { cwd: repo });
  }
  ok("node_modules up to date");
}

function readPiVersion() {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  return pkg.devDependencies?.[PiPackage.Name] ?? pkg.dependencies?.[PiPackage.Name];
}

function shSingleQuote(value) {
  return String(value).replaceAll("'", "'\\''");
}

function readPiPackageEntry(piPackageDir) {
  const packageJsonPath = join(piPackageDir, "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (pkg.name !== PiPackage.Name) fail(`invalid Pi package at ${packageJsonPath}`);
  const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[PiPackage.Bin];
  if (typeof entry !== "string" || entry.length === 0) {
    fail(
      `  ✗  ${PiPackage.Name} does not declare a ${PiPackage.Bin} executable in ${packageJsonPath}`,
    );
  }
  const relativeEntry = relative(resolve(piPackageDir), resolve(piPackageDir, entry));
  if (!relativeEntry || relativeEntry.startsWith("..") || isAbsolute(relativeEntry)) {
    fail(`Pi bin must be inside its package: ${entry}`);
  }
  return relativeEntry;
}

function writePiWrapper(piPackageDir, piPackageEntry, piExecutable) {
  mkdirSync(piBinDir, { recursive: true });
  const sessionManagerStart = join(
    repo,
    ".pi",
    "extensions",
    "session-manager",
    "dist",
    "start.js",
  );
  const sessionManagerExtension = join(
    repo,
    ".pi",
    "extensions",
    "session-manager",
    "dist",
    "index.js",
  );
  const installedWrapper = join(piBinDir, "pi");
  const wrapper = `#!/usr/bin/env sh
set -eu
DEFAULT_PI_PACKAGE_DIR='${shSingleQuote(piPackageDir)}'
PI_PACKAGE_ENTRY='${shSingleQuote(piPackageEntry)}'
PI_EXECUTABLE='${shSingleQuote(piExecutable)}'
SESSION_MANAGER_START='${shSingleQuote(sessionManagerStart)}'
SESSION_MANAGER_EXTENSION='${shSingleQuote(sessionManagerExtension)}'
INSTALLED_PI_WRAPPER='${shSingleQuote(installedWrapper)}'
REQUESTED_PI_PACKAGE_DIR="\${PI_PACKAGE_DIR:-}"
PI_PACKAGE_DIR="$DEFAULT_PI_PACKAGE_DIR"
if [ -z "$PI_EXECUTABLE" ] && [ -n "$REQUESTED_PI_PACKAGE_DIR" ] && [ -f "$REQUESTED_PI_PACKAGE_DIR/package.json" ] && [ -f "$REQUESTED_PI_PACKAGE_DIR/$PI_PACKAGE_ENTRY" ]; then
  PI_PACKAGE_DIR="$REQUESTED_PI_PACKAGE_DIR"
fi
PI_ENTRY="$PI_PACKAGE_DIR/$PI_PACKAGE_ENTRY"
NODE_BIN='${shSingleQuote(setupNodeBin)}'
# Sidecars cannot reliably reuse process.execPath when Node is launched through
# a Nix dynamic-loader wrapper. Preserve setup's Nub-backed runtime selection.
export PI_ENV_NODE_BIN="$NODE_BIN"
if [ -z "\${PI_CODING_AGENT_DIR:-}" ] && [ -n "\${PI_AGENT_DIR:-}" ]; then
  export PI_CODING_AGENT_DIR="$PI_AGENT_DIR"
fi
if [ -n "$PI_EXECUTABLE" ] && [ ! -x "$PI_EXECUTABLE" ]; then
  echo "pi-env: configured Pi executable is unavailable: $PI_EXECUTABLE" >&2
  exit 127
fi
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
if [ "$#" -eq 1 ] && [ "$1" = "--start" ] && [ "\${PI_ENV_SESSION_MANAGER_BYPASS:-}" != "1" ]; then
  if [ ! -f "$SESSION_MANAGER_START" ] || [ ! -f "$SESSION_MANAGER_EXTENSION" ]; then
    echo "pi-env: session manager build is missing. Rerun setup." >&2
    exit 127
  fi
  PI_ENV_PI_WRAPPER="$INSTALLED_PI_WRAPPER" \
  PI_ENV_SESSION_MANAGER_EXTENSION="$SESSION_MANAGER_EXTENSION" \
  PI_NODE_ARGV0=pi exec "$NODE_BIN" "$SESSION_MANAGER_START"
fi
if [ -n "$PI_EXECUTABLE" ]; then
  exec "$PI_EXECUTABLE" "$@"
fi
PI_NODE_ARGV0=pi exec "$NODE_BIN" "$PI_ENTRY" "$@"
`;
  const piPath = join(piBinDir, "pi");
  writeFileSync(piPath, wrapper, { mode: 0o755 });
}

function profileHasPathEntry(profile, binDir, marker) {
  if (!existsSync(profile)) return false;
  const content = readFileSync(profile, "utf8");
  if (content.includes(marker)) return true;
  if (content.includes(binDir) && content.includes("PATH")) return true;
  if (
    binDir === `${process.env.HOME}/.local/bin` &&
    /(\$HOME|~)\/\.local\/bin/.test(content) &&
    content.includes("PATH")
  )
    return true;
  return false;
}

function ensurePathInShellProfiles(binDir, marker = "# pi-env: add user-local bin to PATH") {
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
  const targets =
    existingProfiles.length === 0 && !configured ? [`${home}/.profile`] : existingProfiles;
  for (const profile of targets) {
    const pathExpr =
      binDir === `${home}/.local/bin`
        ? 'export PATH="$HOME/.local/bin:$PATH"'
        : `export PATH="${binDir}:$PATH"`;
    mkdirSync(dirname(profile), { recursive: true });
    const existed = existsSync(profile);
    const prefix = existed ? "\n" : "";
    writeFileSync(profile, `${prefix}${marker}\n${pathExpr}\n`, { flag: "a" });
    ok(`${profile} (${existed ? "appended" : "created"} PATH entry)`);
  }
}

function ensureLocalNixPathInShellProfiles() {
  const home = process.env.HOME;
  const toolchainBin = join(home, ".local/state/pi-env/toolchain/bin");
  const adapterPath = piBinDir === `${home}/.local/bin` ? "$HOME/.local/bin" : piBinDir;
  const start = "# pi-env: local Nix PATH";
  const end = "# pi-env: end local Nix PATH";
  const profiles = [".zshrc", ".bashrc", ".profile"].map(name => join(home, name));
  const existing = profiles.filter(existsSync);
  for (const profile of existing.length ? existing : [join(home, ".profile")]) {
    const current = existsSync(profile) ? readFileSync(profile, "utf8") : "";
    let migrated = current;
    if (!current.includes(end)) {
      for (const [marker, path] of [
        ["# pi-env: add user-local bin to PATH", adapterPath],
        ["# pi-env: add local Nix toolchain to PATH", toolchainBin],
      ]) migrated = migrated.replaceAll(`${marker}\nexport PATH="${path}:$PATH"\n`, "");
    }
    const block = `export PATH="${toolchainBin}:$PATH"\n# pi-env: add user-local bin to PATH\nexport PATH="${adapterPath}:$PATH"`;
    const next = reconcileManagedBlock(migrated, block, start, end);
    if (next !== current) {
      mkdirSync(dirname(profile), { recursive: true });
      writeFileSync(profile, next);
      ok(`${profile} (adapter precedes the retained toolchain)`);
    }
  }
}

function assertPiVersion(piPackageDir, version) {
  const installedVersion = JSON.parse(
    readFileSync(join(piPackageDir, "package.json"), "utf8"),
  ).version;
  if (installedVersion === version) return;
  const source = process.env.PI_PACKAGE_DIR
    ? " PI_PACKAGE_DIR supplies it; update its provisioner (Home Manager: ./setup.sh --sync-home-manager)."
    : "";
  fail(`Pi package version ${installedVersion} does not match the workbench (${version}).${source}`);
}

function installPiCli(policy) {
  section("Pi CLI");
  const version = readPiVersion();
  const piPackageDir = process.env.PI_PACKAGE_DIR
    ? resolve(process.env.PI_PACKAGE_DIR)
    : join(repo, "node_modules", ...PiPackage.Name.split("/"));
  if (!existsSync(join(piPackageDir, "package.json"))) {
    fail(`  ✗  missing pi package after install: ${piPackageDir}`);
  }
  const piPackageEntry = readPiPackageEntry(piPackageDir);
  assertPiVersion(piPackageDir, version);
  const piEntry = join(piPackageDir, piPackageEntry);
  if (!existsSync(piEntry) || !statSync(piEntry).isFile()) {
    fail(`  ✗  missing pi entrypoint after install: ${piEntry}`);
  }
  if (!policy.cli.writeWrapper) {
    ok(`pi ${version} package installed (CLI wrapper managed externally)`);
    return;
  }
  const piExecutable = process.env.PI_ENV_PI_EXECUTABLE
    ? resolve(process.env.PI_ENV_PI_EXECUTABLE) : "";
  if (piExecutable && (!existsSync(piExecutable) || !statSync(piExecutable).isFile()))
    fail(`Pi executable is unavailable: ${piExecutable}`);
  writePiWrapper(piPackageDir, piPackageEntry, piExecutable);
  ok(`pi ${version} → ${join(piBinDir, "pi")}`);
  if (!policy.path.updateShellProfiles) {
    skip("shell profile PATH edits (managed externally)");
  } else if (policy.mode === "local-nix") {
    ensureLocalNixPathInShellProfiles();
  } else if (!process.env.PATH.split(":").includes(piBinDir)) {
    console.log(`  —  ${piBinDir} is not in PATH yet. Updating shell profiles.`);
    ensurePathInShellProfiles(piBinDir);
  }
}

const policy = deriveSetupPolicy(process.env);
switch (command) {
  case RuntimeCommand.Dependencies:
    installDependencies();
    break;
  case RuntimeCommand.PiCli:
    installPiCli(policy);
    break;
  default:
    fail(`unknown runtime setup command: ${command}`, 2);
}
