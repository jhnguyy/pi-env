import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { fileEffect } from "./file-ops.mjs";
import { note, ok, section } from "./report.mjs";
import { SetupStateError } from "./setup-errors.mjs";

// The shell reloads the generation's session variables only after these outcomes.
export const HomeManagerOutcome = Object.freeze({
  Switched: "switched",
  Current: "current",
  Skipped: "skipped",
});

export function configureHomeManagerEffect(ctx, policy) {
  return Effect.gen(function* () {
    section("Home Manager");
    if (!policy.homeManager.sync) {
      note("home-manager sync (disabled by setup option)");
      return HomeManagerOutcome.Skipped;
    }
    const flakeDir = ctx.env.PI_ENV_HOME_MANAGER_FLAKE;
    if (!flakeDir) {
      note("home-manager sync (pi-env.homeManager.sync.enable is not set)");
      return HomeManagerOutcome.Skipped;
    }
    const input = ctx.env.PI_ENV_HOME_MANAGER_INPUT || "pi-env";

    const gitDir = yield* ctx.git(["rev-parse", "--absolute-git-dir"]);
    const gitCommonDir = yield* ctx.git([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (gitDir !== gitCommonDir) {
      note("home-manager sync (worktree checkout — the primary checkout owns sync)");
      return HomeManagerOutcome.Skipped;
    }
    const branch = yield* ctx.git(["branch", "--show-current"]);
    if (branch !== "main") {
      note(`home-manager sync (checkout is on ${branch || "a detached HEAD"}, not main)`);
      return HomeManagerOutcome.Skipped;
    }

    const head = yield* ctx.git(["rev-parse", "HEAD"]);
    const lockFile = join(flakeDir, "flake.lock");
    const locked = yield* lockedRevEffect(lockFile, input);
    if (locked.skip) {
      note(`home-manager sync (${locked.skip})`);
      return HomeManagerOutcome.Skipped;
    }
    if (locked.rev === head) {
      ok(`home-manager ${input} input matches main (${head.slice(0, 7)})`);
      return HomeManagerOutcome.Current;
    }

    // Setup also runs from the post-merge hook; activation stays an explicit request.
    if (!policy.homeManager.update) {
      note(
        `home-manager ${input} input is ${locked.rev.slice(0, 7)}, main is ${head.slice(0, 7)}; run ./setup.sh --sync-home-manager`,
      );
      return HomeManagerOutcome.Skipped;
    }

    // The input fetches the published branch, so update only when local main equals its upstream.
    const upstream = yield* ctx.git(["rev-parse", "--verify", "--quiet", "@{upstream}"], {
      check: false,
    });
    if (upstream !== head) {
      note(
        `home-manager sync (local main ${head.slice(0, 7)} differs from its upstream; push or pull first)`,
      );
      return HomeManagerOutcome.Skipped;
    }

    note(`Updating ${input} input ${locked.rev.slice(0, 7)} → ${head.slice(0, 7)}`);
    yield* ctx.command("nix", ["flake", "update", input, "--flake", flakeDir], { stdio: "inherit" });
    const updated = yield* lockedRevEffect(lockFile, input);
    if (updated.rev !== head) {
      return yield* Effect.fail(
        new SetupStateError(
          `home-manager sync: ${input} locked ${updated.rev?.slice(0, 7) ?? "nothing"} after update, expected ${head.slice(0, 7)}`,
        ),
      );
    }
    yield* ctx.command("home-manager", ["switch", "--flake", flakeDir], { stdio: "inherit" });
    ok(`home-manager switched with ${input} ${head.slice(0, 7)}`);
    return HomeManagerOutcome.Switched;
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
