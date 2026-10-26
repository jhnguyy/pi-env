import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { fileEffect, isLinkTo, pathExistsOrIsSymlink } from "./file-ops.mjs";
import { changed, note, ok, section } from "./report.mjs";

// Relative to each worktree root, so every checkout runs its own tracked hooks.
const HOOKS_PATH = "setup/hooks";
const HookNames = Object.freeze(["post-merge", "pre-commit"]);

export function configureRepoToolsEffect(ctx, policy) {
  return Effect.gen(function* () {
    section("Repo tools");
    if (!policy.repoTools.installHooks) {
      note("repo hooks (disabled by setup option)");
      return;
    }
    const gitDir = yield* ctx.git(["rev-parse", "--absolute-git-dir"]);
    const gitCommonDir = yield* ctx.git([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (gitDir !== gitCommonDir) {
      note(
        "repo hooks (worktree checkout — run setup.sh in the primary checkout to update shared hooks)",
      );
      return;
    }
    // A global or system hook path is user-owned too. Read Git's effective value
    // before setting a repository-local override.
    const hooksPath = yield* ctx.git(["config", "--get", "core.hooksPath"], {
      check: false,
    });
    if (hooksPath === HOOKS_PATH) {
      ok(`repo hooks (core.hooksPath=${HOOKS_PATH})`);
      return;
    }
    if (hooksPath !== "") {
      note(`repo hooks (core.hooksPath already set to ${hooksPath})`);
      return;
    }
    const hooks = HookNames.map((name) => ({
      name,
      src: join(ctx.sourceRoot, HOOKS_PATH, name),
      dst: join(gitCommonDir, "hooks", name),
    }));
    const custom = hooks.filter((hook) => isCustomHook(hook));
    if (custom.length > 0) {
      const names = custom.map((hook) => hook.name).join(", ");
      note(`repo hooks (custom hooks exist in .git/hooks: ${names})`);
      return;
    }
    for (const hook of hooks) {
      yield* fileEffect("remove legacy git hook link", hook.dst, () => {
        if (pathExistsOrIsSymlink(hook.dst)) unlinkSync(hook.dst);
      });
    }
    yield* ctx.git(["config", "--local", "core.hooksPath", HOOKS_PATH]);
    changed(`repo hooks (core.hooksPath=${HOOKS_PATH})`);
  });
}

// Earlier setup versions linked .git/hooks/<name> to the tracked hook; anything else is user-owned.
function isCustomHook({ src, dst }) {
  return pathExistsOrIsSymlink(dst) && !isLinkTo(dst, [src]);
}
