import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import { ok, section, skip } from './runtime-support.mjs';
import { linked, pathExistsOrIsSymlink } from './file-ops.mjs';

export function configureRepoToolsEffect(ctx, policy) {
  return Effect.gen(function* () {
    section('Repo tools');
    if (!policy.repoTools.installHooks) {
      skip('repo hooks (disabled by setup option)');
      return;
    }
    const gitDir = yield* gitPathEffect(ctx, ['rev-parse', '--absolute-git-dir']);
    const gitCommonDir = yield* gitPathEffect(ctx, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (gitDir !== gitCommonDir) {
      skip('repo hooks (worktree checkout — run setup.sh in the primary checkout to update shared hooks)');
    } else {
      yield* installGitHookEffect(ctx, 'post-merge', ctx.postMergeHookSrc, gitCommonDir);
      yield* installGitHookEffect(ctx, 'pre-commit', ctx.preCommitHookSrc, gitCommonDir);
    }
  });
}

function gitPathEffect(ctx, args) {
  return Effect.sync(() => ctx.run('git', ['-C', ctx.repo, ...args], { stdio: 'pipe' }).stdout.trim());
}

function installGitHookEffect(ctx, name, src, gitCommonDir) {
  return Effect.sync(() => {
    const dst = join(gitCommonDir, 'hooks', name);
    mkdirSync(dirname(dst), { recursive: true });
    if (pathExistsOrIsSymlink(dst)) {
      if (!lstatSync(dst).isSymbolicLink()) {
        skip(`${name} hook (custom hook already exists at .git/hooks/${name})`);
        return;
      }
      if (readlinkSync(dst) === src) {
        ok(`${name} hook`);
        return;
      }
      unlinkSync(dst);
    }
    symlinkSync(src, dst);
    ctx.run('chmod', ['+x', src], { stdio: 'ignore' });
    linked(`${name} hook → setup/${name}`);
  });
}
