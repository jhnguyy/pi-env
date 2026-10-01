import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { ok, section, skip } from "./runtime-support.mjs";
import { fileEffect } from "./file-ops.mjs";
import { SetupStateError } from "./setup-errors.mjs";

export function configureHomeManagerEffect(ctx, policy) {
  return Effect.gen(function* () {
    section("Home Manager");
    if (!policy.homeManager.sync) {
      skip("home-manager sync (disabled by setup option)");
      return;
    }
    const flakeDir = ctx.env.PI_ENV_HOME_MANAGER_FLAKE;
    if (!flakeDir) {
      skip("home-manager sync (pi-env.homeManager.sync.enable is not set)");
      return;
    }
    const input = ctx.env.PI_ENV_HOME_MANAGER_INPUT || "pi-env";

    const gitDir = yield* gitEffect(ctx, ["rev-parse", "--absolute-git-dir"]);
    const gitCommonDir = yield* gitEffect(ctx, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (gitDir !== gitCommonDir) {
      skip("home-manager sync (worktree checkout — the primary checkout owns sync)");
      return;
    }
    const branch = yield* gitEffect(ctx, ["branch", "--show-current"]);
    if (branch !== "main") {
      skip(`home-manager sync (checkout is on ${branch || "a detached HEAD"}, not main)`);
      return;
    }

    const head = yield* gitEffect(ctx, ["rev-parse", "HEAD"]);
    const lockFile = join(flakeDir, "flake.lock");
    const locked = yield* lockedRevEffect(lockFile, input);
    if (locked.skip) {
      skip(`home-manager sync (${locked.skip})`);
      return;
    }
    if (locked.rev === head) {
      ok(`home-manager ${input} input matches main (${head.slice(0, 7)})`);
      return;
    }

    // The input fetches the published branch, so update only when local main equals its upstream.
    const upstream = yield* gitEffect(ctx, ["rev-parse", "--verify", "--quiet", "@{upstream}"], {
      check: false,
    });
    if (upstream !== head) {
      skip(
        `home-manager sync (local main ${head.slice(0, 7)} differs from its upstream; push or pull first)`,
      );
      return;
    }

    console.log(`  —  Updating ${input} input ${locked.rev.slice(0, 7)} → ${head.slice(0, 7)}`);
    yield* commandEffect(ctx, "nix", ["flake", "update", input, "--flake", flakeDir]);
    const updated = yield* lockedRevEffect(lockFile, input);
    if (updated.rev !== head) {
      return yield* Effect.fail(
        new SetupStateError(
          `home-manager sync: ${input} locked ${updated.rev?.slice(0, 7) ?? "nothing"} after update, expected ${head.slice(0, 7)}`,
        ),
      );
    }
    yield* commandEffect(ctx, "home-manager", ["switch", "--flake", flakeDir]);
    ok(`home-manager switched with ${input} ${head.slice(0, 7)}`);
  });
}

function lockedRevEffect(lockFile, input) {
  return fileEffect("read Home Manager lock", lockFile, () => {
    if (!existsSync(lockFile)) return { skip: `no flake.lock at ${lockFile}` };
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    const node = lock.nodes?.[lock.root ?? "root"]?.inputs?.[input];
    if (typeof node !== "string") return { skip: `${input} is not a direct input of ${lockFile}` };
    const rev = lock.nodes[node]?.locked?.rev;
    if (typeof rev !== "string") return { skip: `${input} has no locked Git revision` };
    return { rev };
  });
}

function gitEffect(ctx, args, options = {}) {
  return Effect.try({
    try: () =>
      ctx.run("git", ["-C", ctx.repo, ...args], { stdio: "pipe", ...options }).stdout.trim(),
    catch: (error) => error,
  });
}

function commandEffect(ctx, command, args) {
  return Effect.try({
    try: () => ctx.run(command, args, { stdio: "inherit" }),
    catch: (error) => error,
  });
}
