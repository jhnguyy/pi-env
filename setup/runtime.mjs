#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  RuntimeCommand,
  commandSucceeds,
  fail,
  mustEnv,
  run,
  runChecked,
} from "./runtime-support.mjs";
import { note, ok, section } from "./report.mjs";
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
  note("Setup will install repository dependencies with Nub.");
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
  const wrapper = `#!/usr/bin/env sh
set -eu
DEFAULT_PI_PACKAGE_DIR='${shSingleQuote(piPackageDir)}'
PI_PACKAGE_ENTRY='${shSingleQuote(piPackageEntry)}'
PI_EXECUTABLE='${shSingleQuote(piExecutable)}'
NODE_BIN='${shSingleQuote(setupNodeBin)}'
${readFileSync(join(import.meta.dirname, "templates/pi-launcher.sh"), "utf8")}`;
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
  const profiles = [".zshrc", ".bashrc", ".profile"].map((name) => join(home, name));
  const existing = profiles.filter(existsSync);
  for (const profile of existing.length ? existing : [join(home, ".profile")]) {
    const current = existsSync(profile) ? readFileSync(profile, "utf8") : "";
    let migrated = current;
    if (!current.includes(end)) {
      for (const [marker, path] of [
        ["# pi-env: add user-local bin to PATH", adapterPath],
        ["# pi-env: add local Nix toolchain to PATH", toolchainBin],
      ])
        migrated = migrated.replaceAll(`${marker}\nexport PATH="${path}:$PATH"\n`, "");
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
  fail(
    `Pi package version ${installedVersion} does not match the workbench (${version}).${source}`,
  );
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
    ? resolve(process.env.PI_ENV_PI_EXECUTABLE)
    : "";
  if (piExecutable && (!existsSync(piExecutable) || !statSync(piExecutable).isFile()))
    fail(`Pi executable is unavailable: ${piExecutable}`);
  writePiWrapper(piPackageDir, piPackageEntry, piExecutable);
  ok(`pi ${version} → ${join(piBinDir, "pi")}`);
  if (!policy.path.updateShellProfiles) {
    note("shell profile PATH edits (managed externally)");
  } else if (policy.mode === "local-nix") {
    ensureLocalNixPathInShellProfiles();
  } else if (!process.env.PATH.split(":").includes(piBinDir)) {
    note(`${piBinDir} is not in PATH yet. Updating shell profiles.`);
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
