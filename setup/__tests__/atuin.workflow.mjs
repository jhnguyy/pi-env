import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/setup-atuin.mjs");
const binary = process.env.PI_ENV_TEST_ATUIN;

test(
  "managed rerun from an enabled shell does not select its own wrapper",
  { skip: !binary },
  async (t) => {
    const { directory, env } = await fixture(t);
    const tools = join(directory, "tools");
    await mkdir(tools);
    await symlink(binary, join(tools, "atuin"));
    env.PATH = `${tools}:${env.PATH}`;
    const args = [
      script,
      "--sync-url",
      "https://history.example.test",
      "--nix-managed",
      "--shell",
      "none",
    ];
    let result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const wrapper = join(env.PI_CODING_AGENT_DIR, "atuin/bin/atuin");
    env.PATH = `${dirname(wrapper)}:${env.PATH}`;
    result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(atuin(env, wrapper, ["--version"]), /^atuin 18\.24\.6/);
  },
);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-env-atuin-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  await mkdir(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    ATUIN_HOME: join(home, ".atuin"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_RUNTIME_DIR: join(directory, "run"),
    PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
    PI_ENV_CONFIG_MANAGED_BY_NIX: "1",
  };
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  return { directory, home, env };
}

function run(env, args = [], atuin = binary) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--sync-url",
      "https://history.example.test",
      "--nix-managed",
      "--shell",
      "bash",
      "--atuin",
      atuin,
      ...args,
    ],
    { env, encoding: "utf8" },
  );
}

function atuin(env, path, args) {
  const result = spawnSync(path, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("capture requires an explicit environment state directory before provisioning", async (t) => {
  const { env } = await fixture(t);
  const result = run({ ...env, ATUIN_HOME: "" }, [], "/not-provisioned/atuin");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set an absolute ATUIN_HOME/);
  await assert.rejects(readFile(join(env.PI_CODING_AGENT_DIR, "mcp.json")), { code: "ENOENT" });
});

for (const failure of ["version", "capability"]) {
  test(`${failure} failure leaves selected state untouched`, async (t) => {
    const { directory, home, env } = await fixture(t);
    const fake = join(directory, "atuin");
    await writeFile(
      fake,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 'atuin ${failure === "version" ? "18.12.0" : "18.24.6"}'; exit 0; fi\nexit 1\n`,
    );
    await chmod(fake, 0o755);
    const result = run(env, [], fake);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(join(env.ATUIN_HOME, "config.toml")), { code: "ENOENT" });
    await assert.rejects(readFile(join(env.PI_CODING_AGENT_DIR, "mcp.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(home, ".bashrc")), { code: "ENOENT" });
  });
}

test(
  "reruns preserve unrelated TOML, Pi settings, MCP servers and managed profiles",
  { skip: !binary },
  async (t) => {
    const { home, env } = await fixture(t);
    await mkdir(env.ATUIN_HOME);
    await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
    const config = join(env.ATUIN_HOME, "config.toml");
    await writeFile(
      config,
      '# personal preference\nsearch_mode = "prefix"\n[threads]\ncapture_tools = false\n',
    );
    const settings = join(env.PI_CODING_AGENT_DIR, "settings.json");
    await writeFile(settings, '{"theme":"personal"}\n');
    const mcpPath = join(env.PI_CODING_AGENT_DIR, "mcp.json");
    await writeFile(
      mcpPath,
      JSON.stringify({ custom: true, mcpServers: { other: { command: "other", args: [] } } }),
    );
    await writeFile(join(home, ".bashrc"), "# provisioner owns this\n");
    let result = run(env);
    assert.equal(result.status, 0, result.stderr);
    const first = await readFile(config, "utf8");
    const preferences = JSON.parse(await readFile(mcpPath, "utf8"));
    Object.assign(preferences.mcpServers.atuin, {
      enabled: false,
      exposure: "hidden",
      toolExposure: { atuin_history: "direct" },
    });
    await writeFile(mcpPath, JSON.stringify(preferences));
    result = run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(config, "utf8"), first);
    assert.match(first, /# personal preference/);
    assert.equal(await readFile(settings, "utf8"), '{"theme":"personal"}\n');
    assert.equal(await readFile(join(home, ".bashrc"), "utf8"), "# provisioner owns this\n");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    assert.equal(mcp.custom, true);
    assert.deepEqual(mcp.mcpServers.other, { command: "other", args: [] });
    assert.equal(mcp.mcpServers.atuin.enabled, false);
    assert.equal(mcp.mcpServers.atuin.exposure, "hidden");
    assert.deepEqual(mcp.mcpServers.atuin.toolExposure, { atuin_history: "direct" });
    const wrapper = mcp.mcpServers.atuin.command;
    assert.match(atuin(env, wrapper, ["daemon", "status"]), /not running/i);
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pi-env-test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const server = spawnSync(wrapper, ["mcp"], {
      env: { HOME: home, PATH: env.PATH },
      encoding: "utf8",
      input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
      timeout: 10000,
    });
    assert.equal(server.status, 0, server.stderr);
    const tools = server.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((reply) => reply.id === 2)
      .result.tools.map((tool) => tool.name);
    for (const tool of [
      "atuin_history",
      "atuin_output",
      "atuin_output_search",
      "atuin_threads_search",
      "atuin_threads_list",
      "atuin_threads_read",
    ])
      assert.ok(tools.includes(tool));
    for (const key of [
      "auto_sync",
      "sync.records",
      "daemon.enabled",
      "daemon.autostart",
      "pty_proxy.enabled",
      "output.enabled",
      "threads.capture",
      "threads.capture_tools",
    ]) {
      assert.equal(
        atuin({ HOME: home, PATH: env.PATH }, wrapper, ["config", "get", key, "--resolved"]),
        "true",
      );
    }
    assert.equal(atuin(env, wrapper, ["config", "get", "search_mode"]), "prefix");
    assert.equal(
      atuin(env, wrapper, ["config", "get", "sync_address"]),
      "https://history.example.test",
    );
    const init = atuin(env, wrapper, ["init", "bash", "--disable-ai"]);
    assert.match(init, /pty-proxy/);
    assert.match(
      await readFile(join(env.PI_CODING_AGENT_DIR, "atuin/init.bash"), "utf8"),
      /--disable-ai/,
    );
    await assert.rejects(readFile(join(env.ATUIN_HOME, "data/session")), { code: "ENOENT" });
  },
);

test(
  "an existing external atuin MCP registration is not replaced",
  { skip: !binary },
  async (t) => {
    const { env } = await fixture(t);
    await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
    const mcpPath = join(env.PI_CODING_AGENT_DIR, "mcp.json");
    const original = JSON.stringify({ mcpServers: { atuin: { url: "https://mcp.example.test" } } });
    await writeFile(mcpPath, original);
    const result = run(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /belongs to another configuration/);
    assert.equal(await readFile(mcpPath, "utf8"), original);
    await assert.rejects(readFile(join(env.ATUIN_HOME, "config.toml")), { code: "ENOENT" });
  },
);

test(
  "portable profile blocks preserve user content on rerun without installing over managed tools",
  { skip: !binary },
  async (t) => {
    const { home, env } = await fixture(t);
    delete env.PI_ENV_CONFIG_MANAGED_BY_NIX;
    await writeFile(join(home, ".bashrc"), "export PERSONAL=yes\n");
    const args = [
      script,
      "--sync-url",
      "https://history.example.test",
      "--portable",
      "--shell",
      "bash",
      "--atuin",
      binary,
    ];
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, args, { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const profile = await readFile(join(home, ".bashrc"), "utf8");
    assert.ok(profile.startsWith("export PERSONAL=yes\n"));
    assert.equal(profile.match(/# pi-env:atuin:start/g).length, 1);
  },
);

test(
  "home and work wrappers retain their own native state even under the other profile environment",
  { skip: !binary },
  async (t) => {
    const { home, env } = await fixture(t);
    const work = {
      ...env,
      ATUIN_HOME: join(home, "work-atuin"),
      PI_CODING_AGENT_DIR: join(home, "work-agent"),
      XDG_CONFIG_HOME: join(home, "work-config"),
      XDG_DATA_HOME: join(home, "work-data"),
    };
    assert.equal(run(env).status, 0);
    assert.equal(run(work, ["--sync-url", "https://work.example.test"]).status, 0);
    const personalWrapper = join(env.PI_CODING_AGENT_DIR, "atuin/bin/atuin");
    const workWrapper = join(work.PI_CODING_AGENT_DIR, "atuin/bin/atuin");
    assert.equal(
      atuin(work, personalWrapper, ["config", "get", "sync_address"]),
      "https://history.example.test",
    );
    assert.equal(
      atuin(env, workWrapper, ["config", "get", "sync_address"]),
      "https://work.example.test",
    );
    assert.ok(
      atuin(work, personalWrapper, ["info"]).includes(join(env.ATUIN_HOME, "data/history.db")),
    );
    assert.ok(atuin(env, workWrapper, ["info"]).includes(join(work.ATUIN_HOME, "data/history.db")));
    const fragment = join(env.PI_CODING_AGENT_DIR, "atuin/init.bash");
    const shell = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-ic",
        'atuin() { if [[ $1 = init ]]; then :; else command atuin "$@"; fi; }; . "$1"; test "$XDG_CONFIG_HOME" = "$2" && test "$XDG_DATA_HOME" = "$3" && test "$(atuin config get sync_address)" = https://history.example.test',
        "bash",
        fragment,
        work.XDG_CONFIG_HOME,
        work.XDG_DATA_HOME,
      ],
      { env: work, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(shell.status, 0, shell.stderr);
  },
);
