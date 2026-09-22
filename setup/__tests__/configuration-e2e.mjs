import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as fs from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const limit = 64 * 1024;
const start = "<!-- pi-env:agent-guidelines:start -->";
const end = "<!-- pi-env:agent-guidelines:end -->";
const appendMarker = "<!-- pi-env:append-system -->";
const command = "bash setup/__tests__/configuration.e2e.test.sh";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const json = (path, value) => fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function read(path) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.size > limit)
    throw new Error(`Expected a regular file of at most ${limit} bytes: ${path}`);
  return fs.readFileSync(path, "utf8");
}

function git(...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: limit });
  if (result.status !== 0 || result.error) throw new Error(`Git metadata unavailable: ${args[0]}`);
  return result.stdout.trim();
}

function verify(directory) {
  const manifest = JSON.parse(read(join(directory, "manifest.json")));
  if (manifest.complete !== true) throw new Error("Scenario capture did not complete.");
  const expected = JSON.parse(read(join(directory, "expected.json")));
  const observations = [];
  const check = (claim, actual, wanted) =>
    observations.push({
      claim,
      expected: wanted,
      actual,
      passed: isDeepStrictEqual(actual, wanted),
    });
  const count = (text, marker) => text.split(marker).length - 1;
  const snapshots = [];
  for (const run of [1, 2]) {
    check(`run ${run}: exit status`, manifest.runs[run - 1]?.status, 0);
    check(`run ${run}: complete capture`, manifest.runs[run - 1]?.captureComplete, true);
    const snapshot = JSON.parse(read(join(directory, `run-${run}.json`)));
    snapshots.push(snapshot);
    check(`run ${run}: local guidance prefix`, snapshot.agents.startsWith(expected.prefix), true);
    check(`run ${run}: local guidance suffix`, snapshot.agents.endsWith(expected.suffix), true);
    check(
      `run ${run}: managed block count`,
      [count(snapshot.agents, start), count(snapshot.agents, end)],
      [1, 1],
    );
    check(
      `run ${run}: managed guidance reconciled`,
      snapshot.agents.includes(`${start}\n${expected.guidance.trim()}\n${end}`),
      true,
    );
    check(
      `run ${run}: local append prefix`,
      snapshot.append.startsWith(expected.appendPrefix),
      true,
    );
    check(
      `run ${run}: repository append payload installed once`,
      count(snapshot.append, expected.append.trim()),
      1,
    );
    check(`run ${run}: synthetic auth preserved`, snapshot.authHash, expected.authHash);
    for (const [key, value] of Object.entries(expected.userSettings)) {
      check(`run ${run}: user setting ${key}`, snapshot.settings[key], value);
    }
    check(`run ${run}: managed retry settings applied`, snapshot.settings.retry, expected.retry);
    check(`run ${run}: package registered once`, snapshot.settings.packages, ["<PACKAGE>"]);
    check(`run ${run}: test utility links`, snapshot.links, expected.links);
    check(
      `run ${run}: guidance content hash`,
      sha256(snapshot.agents),
      snapshot.fileHashes["AGENTS.md"],
    );
    check(
      `run ${run}: append content hash`,
      sha256(snapshot.append),
      snapshot.fileHashes["APPEND_SYSTEM.md"],
    );
    check(
      `run ${run}: snapshot integrity`,
      sha256(read(join(directory, `run-${run}.json`))),
      manifest.runs[run - 1]?.snapshotHash,
    );
  }
  check("second run preserves the selected outputs", snapshots[1], snapshots[0]);
  return { passed: observations.every((item) => item.passed), observations };
}

function runScenario() {
  const parent = resolve(
    process.env.PI_ENV_E2E_ARTIFACT_DIR || join(root, ".artifacts/setup-configuration"),
  );
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(join(parent, "run-"));
  const fixture = fs.mkdtempSync(join(tmpdir(), "pi-env-configuration-"));
  const home = join(fixture, "home");
  const agent = join(home, ".pi/agent");
  const node = process.env.PI_ENV_TEST_NODE_BIN;
  const manifest = {
    version: 1,
    scenario: "setup-pi-configuration-v1",
    command,
    boundary: "setup/configure.mjs pi",
    mode: "nix-managed",
    runs: [],
    complete: false,
  };
  console.log(`Setup configuration evidence: ${directory}`);
  try {
    if (!node)
      throw new Error("Run through the shell entrypoint to select the repository Node runtime.");
    const packageRoot = git("worktree", "list", "--porcelain")
      .split("\n")[0]
      .slice("worktree ".length);
    const normalize = (text) =>
      text
        .replaceAll(fixture, "<FIXTURE>")
        .replaceAll(root, "<REPO>")
        .replaceAll(packageRoot, "<PACKAGE>");
    manifest.revision = git("rev-parse", "HEAD");
    manifest.dirty = git("status", "--porcelain").length > 0;
    manifest.diffHash = sha256(git("diff", "HEAD"));
    manifest.scenarioHash = sha256(read(fileURLToPath(import.meta.url)));
    manifest.runtime = {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    };
    manifest.repeat = command;
    manifest.verify = `${command} --verify <artifact-directory>`;
    const prefix = "# Local instructions\n\nPreserve this local rule.\n\n";
    const suffix = "\n\nPreserve this trailing rule.\n";
    const userSettings = {
      defaultProvider: "fixture-provider",
      defaultModel: "fixture-model",
      theme: "fixture-theme",
      fixturePreference: { keep: true },
    };
    const auth = '{"fixture":"synthetic-auth-sentinel"}\n';
    const appendPrefix = "# Local append instructions\n\nPreserve this append rule.\n";
    const seed = {
      agents: `${prefix}${start}\nstale managed guidance\n${end}${suffix}`,
      append: appendPrefix,
      settings: userSettings,
      authHash: sha256(auth),
    };
    const utilityNames = ["test-utils.ts", "loader.test.ts"];
    const expected = {
      prefix,
      suffix,
      appendPrefix,
      userSettings,
      authHash: seed.authHash,
      guidance: read(join(root, "setup/templates/AGENTS.md")),
      append: read(join(root, ".pi/agent/APPEND_SYSTEM.md")),
      retry: JSON.parse(read(join(root, "setup/config/managed-settings.json"))).retry,
      links: utilityNames.map((name) => `<REPO>/.pi/extensions/__tests__/${name}`),
    };
    json(join(directory, "seed.json"), seed);
    json(join(directory, "expected.json"), expected);
    manifest.fixtureHash = sha256(read(join(directory, "seed.json")));
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(join(agent, "AGENTS.md"), seed.agents);
    fs.writeFileSync(join(agent, "APPEND_SYSTEM.md"), seed.append);
    fs.writeFileSync(join(agent, "auth.json"), auth);
    json(join(agent, "settings.json"), userSettings);
    // Only fixture-owned paths and required runtime values reach the real configuration CLI.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: fixture,
      LANG: "C.UTF-8",
      PI_ENV_NODE_BIN: node,
      PI_ENV_SETUP_MODE: "nix-managed",
      REPO: root,
      SETUP_DIR: join(root, "setup"),
      PI_AGENT_DIR: agent,
      AGENTS_DIR: join(home, ".agents"),
      SETTINGS_FILE: join(agent, "settings.json"),
      MANAGED_SETTINGS_FILE: join(root, "setup/config/managed-settings.json"),
      TEST_UTILS_DIR: join(agent, "extensions/__tests__"),
      APPEND_SRC: join(root, ".pi/agent/APPEND_SYSTEM.md"),
      APPEND_DST: join(agent, "APPEND_SYSTEM.md"),
      APPEND_MARKER: appendMarker,
      TMUX_CONF: join(home, ".tmux.conf"),
      TMUX_SOURCE_LINE: `source-file ${root}/setup/templates/tmux.conf`,
      GHOSTTY_CONFIG_DIR: join(home, ".config/ghostty"),
      POST_MERGE_HOOK_SRC: join(root, "setup/hooks/post-merge"),
      PRE_COMMIT_HOOK_SRC: join(root, "setup/hooks/pre-commit"),
    };
    json(join(directory, "manifest.json"), manifest);
    for (const run of [1, 2]) {
      const result = spawnSync(node, [join(root, "setup/configure.mjs"), "pi", node], {
        cwd: root,
        env,
        encoding: "utf8",
        maxBuffer: limit,
      });
      const record = {
        status: result.status,
        signal: result.signal,
        captureComplete:
          !result.error &&
          Buffer.byteLength(result.stdout || "") <= limit &&
          Buffer.byteLength(result.stderr || "") <= limit,
      };
      manifest.runs.push(record);
      for (const stream of ["stdout", "stderr"]) {
        const bounded = Buffer.from(result[stream] || "")
          .subarray(0, limit)
          .toString("utf8");
        fs.writeFileSync(join(directory, `run-${run}.${stream}.log`), normalize(bounded));
      }
      json(join(directory, "manifest.json"), manifest);
      const captureErrors = [];
      const capture = (name, operation) => {
        try {
          return operation();
        } catch {
          captureErrors.push(name);
          return null;
        }
      };
      const settings = capture("settings.json", () =>
        JSON.parse(read(join(agent, "settings.json"))),
      );
      if (settings)
        settings.packages = settings.packages?.map((source) =>
          typeof source === "string" && resolve(agent, source) === packageRoot
            ? "<PACKAGE>"
            : source,
        );
      const snapshot = {
        settings,
        agents: capture("AGENTS.md", () => read(join(agent, "AGENTS.md"))),
        append: capture("APPEND_SYSTEM.md", () => read(join(agent, "APPEND_SYSTEM.md"))),
        authHash: capture("auth.json", () => sha256(read(join(agent, "auth.json")))),
        links: utilityNames.map((name) =>
          capture(name, () =>
            normalize(fs.readlinkSync(join(agent, "extensions/__tests__", name))),
          ),
        ),
        fileHashes: Object.fromEntries(
          ["settings.json", "AGENTS.md", "APPEND_SYSTEM.md"].map((name) => [
            name,
            capture(name, () => sha256(read(join(agent, name)))),
          ]),
        ),
        captureErrors,
      };
      json(join(directory, `run-${run}.json`), snapshot);
      record.snapshotHash = sha256(read(join(directory, `run-${run}.json`)));
      json(join(directory, "manifest.json"), manifest);
      if (record.status !== 0 || !record.captureComplete || captureErrors.length)
        throw new Error(`Configuration run ${run} failed or produced incomplete evidence.`);
    }
    manifest.complete = true;
    json(join(directory, "manifest.json"), manifest);
    const result = verify(directory);
    json(join(directory, "observations.json"), result);
    if (!result.passed)
      throw new Error("Configuration observations failed. See observations.json.");
  } catch (error) {
    manifest.failure = error instanceof Error ? error.message : String(error);
    json(join(directory, "manifest.json"), manifest);
    if (!fs.existsSync(join(directory, "observations.json"))) {
      json(join(directory, "observations.json"), {
        passed: false,
        incomplete: true,
        failure: manifest.failure,
      });
    }
    process.exitCode = 1;
    console.error(manifest.failure);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

const [action, directory, ...extra] = process.argv.slice(2);
if (action === "--verify" && directory && extra.length === 0) {
  try {
    const result = verify(resolve(directory));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(`Incomplete or invalid evidence: ${error.message}`);
    process.exitCode = 1;
  }
} else if (action === undefined) {
  runScenario();
} else {
  console.error(`Usage: ${command} [--verify <artifact-directory>]`);
  process.exitCode = 2;
}
