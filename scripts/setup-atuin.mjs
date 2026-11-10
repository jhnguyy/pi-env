import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { reconcileManagedBlock } from "../setup/managed-block.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const release = JSON.parse(await readFile(join(root, "setup/atuin-release.json"), "utf8"));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const compatible = (output) => /^atuin (\S+)/.exec(output)?.[1] === release.version;

function command(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { env, encoding: "utf8" });
  // Do not echo config, command output, or environment on failure.
  if (result.error || result.status !== 0) {
    throw new Error(`${executable}: ${args.slice(0, 2).join(" ")} failed`);
  }
  return result.stdout;
}

async function optionalRead(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function save(path, content, mode = 0o600, preserveMode = false) {
  if (preserveMode) {
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  // Write through existing profile symlinks; managed mode never calls this for profiles.
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

async function findAtuin() {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const path = resolve(directory, "atuin");
    if (await optionalRead(join(directory, ".pi-env-atuin-wrapper"))) continue;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error("Atuin is missing from PATH; provision the pinned Nix atuin package first");
}

async function install(home) {
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  const artifact = release.artifacts[`${arch}-${process.platform}`];
  if (!artifact) throw new Error("No pinned Atuin artifact for this platform");
  const destination = join(process.env.PI_BIN_DIR || join(home, ".local/bin"), "atuin");
  try {
    if (compatible(command(destination, ["--version"]))) return resolve(destination);
  } catch {
    // Install only in the explicitly selected portable binary directory.
  }
  const temporary = await mkdtemp(join(tmpdir(), "pi-env-atuin-"));
  try {
    const name = `atuin-${artifact.target}`;
    const archive = join(temporary, "atuin.tar.gz");
    command("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "3",
      "--connect-timeout",
      "30",
      "--max-time",
      "300",
      "--output",
      archive,
      `https://github.com/atuinsh/atuin/releases/download/v${release.version}/${name}.tar.gz`,
    ]);
    const data = await readFile(archive);
    if (createHash("sha256").update(data).digest("hex") !== artifact.sha256) {
      throw new Error("Atuin artifact checksum mismatch");
    }
    command("tar", ["xzf", archive, "-C", temporary, `${name}/atuin`]);
    await mkdir(dirname(destination), { recursive: true });
    const pending = `${destination}.pi-env-${process.pid}`;
    try {
      await copyFile(join(temporary, name, "atuin"), pending);
      await chmod(pending, 0o755);
      await rename(pending, destination);
    } finally {
      await rm(pending, { force: true });
    }
    return resolve(destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "sync-url": { type: "string" },
      portable: { type: "boolean" },
      "nix-managed": { type: "boolean" },
      shell: { type: "string" },
      atuin: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/setup-atuin.mjs --sync-url URL (--portable|--nix-managed) --shell bash|zsh|none [--atuin /absolute/path]",
    );
    return;
  }
  if (
    !values["sync-url"] ||
    Boolean(values.portable) === Boolean(values["nix-managed"]) ||
    !["bash", "zsh", "none"].includes(values.shell)
  ) {
    throw new Error("Supply --sync-url, exactly one mode, and --shell bash|zsh|none (see --help)");
  }
  const url = new URL(values["sync-url"]);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Sync URL must be HTTP(S), without credentials, query, or fragment");
  }
  if (values.portable && process.env.PI_ENV_CONFIG_MANAGED_BY_NIX === "1") {
    throw new Error("Shell config is Nix-managed; use --nix-managed");
  }
  const home = process.env.HOME;
  if (!home || !home.startsWith("/")) throw new Error("HOME must be absolute");
  if (!process.env.ATUIN_HOME) {
    throw new Error("Set an absolute ATUIN_HOME for this environment before enabling capture");
  }
  for (const name of [
    "ATUIN_HOME",
    "ATUIN_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "PI_BIN_DIR",
  ]) {
    if (process.env[name] && !process.env[name].startsWith("/"))
      throw new Error(`${name} must be absolute`);
  }
  const agentDir = command("bash", [
    "-c",
    'source "$1"; pi_env_resolve_agent_dir || exit; printf "%s" "$PI_CODING_AGENT_DIR"',
    "bash",
    join(root, "setup/agent-dir.sh"),
  ]);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir };
  if (values.atuin && !values.atuin.startsWith("/")) {
    throw new Error(
      "--atuin must be an absolute path to the underlying CLI, not a profile wrapper",
    );
  }
  const binary = values.atuin
    ? resolve(values.atuin)
    : values.portable
      ? await install(home)
      : await findAtuin();
  if (await optionalRead(join(dirname(binary), ".pi-env-atuin-wrapper"))) {
    throw new Error("Select the underlying Atuin CLI, not a profile wrapper");
  }
  if (!compatible(command(binary, ["--version"], env))) {
    throw new Error(`Atuin ${release.version} is required; provision the pinned package`);
  }
  for (const args of [
    ["config", "set", "--help"],
    ["mcp", "--help"],
    ["threads", "--help"],
    ["pty-proxy", "--help"],
    ["daemon", "--help"],
    ["init", "--help"],
  ]) {
    command(binary, args, env);
  }
  const directory = join(agentDir, "atuin");
  const wrapper = join(directory, "bin/atuin");
  const mcpPath = join(agentDir, "mcp.json");
  let mcp;
  const mcpText = await optionalRead(mcpPath);
  try {
    mcp = JSON.parse(mcpText || "{}");
  } catch {
    throw new Error("Invalid Pi mcp.json JSON; no config changed");
  }
  if (
    !mcp ||
    Array.isArray(mcp) ||
    typeof mcp !== "object" ||
    (mcp.mcpServers !== undefined &&
      (!mcp.mcpServers || Array.isArray(mcp.mcpServers) || typeof mcp.mcpServers !== "object"))
  ) {
    throw new Error("Invalid Pi mcp.json; no config changed");
  }
  const existingServer = mcp.mcpServers?.atuin;
  if (
    existingServer !== undefined &&
    (!existingServer ||
      typeof existingServer !== "object" ||
      Array.isArray(existingServer) ||
      existingServer.url ||
      (existingServer.command && existingServer.command !== wrapper) ||
      (existingServer.type && existingServer.type !== "stdio"))
  ) {
    throw new Error("The atuin MCP name belongs to another configuration; resolve it before setup");
  }
  mcp.mcpServers = {
    ...mcp.mcpServers,
    atuin: { ...existingServer, command: wrapper, args: ["mcp"] },
  };
  const profile =
    values.shell === "none" || values["nix-managed"]
      ? undefined
      : join(home, values.shell === "bash" ? ".bashrc" : ".zshrc");
  const profileText = profile
    ? reconcileManagedBlock(
        await optionalRead(profile),
        `. ${quote(join(directory, `init.${values.shell}`))}`,
        "# pi-env:atuin:start",
        "# pi-env:atuin:end",
      )
    : undefined;

  // Native config set preserves TOML comments and unrelated keys. Unlike config enable,
  // it never offers imports or restarts a daemon while preparing a machine.
  for (const [key, value, type] of [
    ["sync_address", values["sync-url"], "string"],
    ["auto_sync", "true", "boolean"],
    ["sync.records", "true", "boolean"],
    ["daemon.enabled", "true", "boolean"],
    ["daemon.autostart", "true", "boolean"],
    ["pty_proxy.enabled", "true", "boolean"],
    ["output.enabled", "true", "boolean"],
    ["threads.capture", "true", "boolean"],
    ["threads.capture_tools", "true", "boolean"],
  ])
    command(binary, ["config", "set", key, value, "--type", type], env);

  await save(join(directory, "bin/.pi-env-atuin-wrapper"), "pi-env\n");
  // ATUIN_HOME makes the native layout independent of XDG. Do not bind XDG here:
  // the PTY wrapper also supplies the replacement shell's environment.
  const selectors = ["ATUIN_HOME", "ATUIN_CONFIG_DIR", "PI_CODING_AGENT_SESSION_DIR"];
  const exports = selectors.map((name) =>
    env[name] ? `export ${name}=${quote(env[name])}` : `unset ${name}`,
  );
  const profileEnvironment = `${exports.join("\n")}\nexport PI_CODING_AGENT_DIR=${quote(agentDir)}\nexport PI_AGENT_DIR=${quote(agentDir)}`;
  await save(wrapper, `#!/bin/sh\n${profileEnvironment}\nexec ${quote(binary)} "$@"\n`, 0o755);
  for (const shell of ["bash", "zsh"]) {
    await save(
      join(directory, `init.${shell}`),
      `# Source only from an interactive ${shell} profile.\nif [[ $- == *i* ]]; then\n  export PATH=${quote(dirname(wrapper))}:"$PATH"\n  eval "$(atuin init ${shell} --disable-ai)"\nfi\n`,
    );
  }
  await save(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  if (profile) await save(profile, profileText, 0o644, true);
  console.log(
    `Atuin configured. Shell fragments: ${directory}/init.{bash,zsh}. Open a new shell; restart an existing Atuin daemon in this profile after setup. No login, import, or sync was run.`,
  );
}

main().catch((error) => {
  console.error(`Atuin setup: ${error.message}`);
  process.exitCode = 1;
});
