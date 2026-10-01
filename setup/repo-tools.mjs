import { lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { ok, section, skip } from "./runtime-support.mjs";
import { fileEffect, linked, pathExistsOrIsSymlink } from "./file-ops.mjs";

// Relative to each worktree root, so every checkout runs its own tracked hooks.
const HOOKS_PATH = "setup/hooks";

export function configureRepoToolsEffect(ctx, policy) {
  return Effect.gen(function* () {
    section("Repo tools");
    if (!policy.repoTools.installHooks) {
      skip("repo hooks (disabled by setup option)");
      return;
    }
    const gitDir = yield* gitEffect(ctx, ["rev-parse", "--absolute-git-dir"]);
    const gitCommonDir = yield* gitEffect(ctx, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (gitDir !== gitCommonDir) {
      skip(
        "repo hooks (worktree checkout — run setup.sh in the primary checkout to update shared hooks)",
      );
      return;
    }
    // A global or system hook path is user-owned too. Read Git's effective value
    // before setting a repository-local override.
    const hooksPath = yield* gitEffect(ctx, ["config", "--get", "core.hooksPath"], {
      check: false,
    });
    if (hooksPath === HOOKS_PATH) {
      ok(`repo hooks (core.hooksPath=${HOOKS_PATH})`);
      return;
    }
    if (hooksPath !== "") {
      skip(`repo hooks (core.hooksPath already set to ${hooksPath})`);
      return;
    }
    const hooks = [
      { name: "post-merge", src: ctx.postMergeHookSrc },
      { name: "pre-commit", src: ctx.preCommitHookSrc },
    ].map((hook) => ({ ...hook, dst: join(gitCommonDir, "hooks", hook.name) }));
    const custom = hooks.filter((hook) => isCustomHook(hook));
    if (custom.length > 0) {
      const names = custom.map((hook) => hook.name).join(", ");
      skip(`repo hooks (custom hooks exist in .git/hooks: ${names})`);
      return;
    }
    for (const hook of hooks) {
      yield* fileEffect("remove legacy git hook link", hook.dst, () => {
        if (pathExistsOrIsSymlink(hook.dst)) unlinkSync(hook.dst);
      });
    }
    yield* gitEffect(ctx, ["config", "--local", "core.hooksPath", HOOKS_PATH]);
    linked(`repo hooks (core.hooksPath=${HOOKS_PATH})`);
  });
}

// Earlier setup versions linked .git/hooks/<name> to the tracked hook; anything else is user-owned.
function isCustomHook({ src, dst }) {
  if (!pathExistsOrIsSymlink(dst)) return false;
  return !lstatSync(dst).isSymbolicLink() || readlinkSync(dst) !== src;
}

function gitEffect(ctx, args, options = {}) {
  return Effect.try({
    try: () =>
      ctx.run("git", ["-C", ctx.repo, ...args], { stdio: "pipe", ...options }).stdout.trim(),
    catch: (error) => error,
  });
}
