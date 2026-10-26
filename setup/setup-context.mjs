import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { SetupCommandExitError, SetupCommandStartError, SetupEnvError } from "./setup-errors.mjs";

// Assets come from the checkout that contains this code; `repo` is the checkout being configured.
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function requiredEnvEffect(env, name) {
  const value = env[name];
  return value ? Effect.succeed(value) : Effect.fail(new SetupEnvError(name));
}

function defaultGhosttyConfigDir(home, xdgConfigHome) {
  return process.platform === "darwin"
    ? join(home, "Library/Application Support/com.mitchellh.ghostty")
    : join(xdgConfigHome, "ghostty");
}

function makeCommands(repo, env) {
  function command(executable, args, options = {}) {
    return Effect.try({
      try: () => {
        const result = spawnSync(executable, args, {
          cwd: options.cwd ?? repo,
          env,
          stdio: options.stdio ?? "pipe",
          encoding: "utf8",
        });
        if (result.error) throw new SetupCommandStartError(executable, args, result.error);
        if (result.status !== 0 && options.check !== false) {
          throw new SetupCommandExitError(executable, args, result.status, result.stderr);
        }
        return result;
      },
      catch: (error) => error,
    });
  }
  function git(args, options = {}) {
    return command("git", ["-C", repo, ...args], options).pipe(
      Effect.map((result) => result.stdout.trim()),
    );
  }
  return { command, git };
}

export function parseSetupContextEffect(env, setupNodeBin) {
  return Effect.gen(function* () {
    const repo = yield* requiredEnvEffect(env, "REPO");
    const agentDir = yield* requiredEnvEffect(env, "PI_CODING_AGENT_DIR");
    const home = yield* requiredEnvEffect(env, "HOME");
    const xdgConfigHome = env.XDG_CONFIG_HOME || join(home, ".config");
    return Object.freeze({
      env,
      setupNodeBin,
      repo,
      sourceRoot,
      home,
      agentDir,
      agentsDir: env.AGENTS_DIR || join(home, ".agents"),
      xdgConfigHome,
      ghosttyConfigDir: env.GHOSTTY_CONFIG_DIR || defaultGhosttyConfigDir(home, xdgConfigHome),
      ...makeCommands(repo, env),
    });
  });
}
