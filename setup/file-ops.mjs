import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { Effect } from "effect";
import { reconcileNamedBlocks } from "./managed-block.mjs";
import { changed, kept, ok, relinked } from "./report.mjs";
import { isSetupError, SetupFileError, SetupStateError } from "./setup-errors.mjs";

export function pathExistsOrIsSymlink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function fileEffect(operation, path, thunk) {
  return Effect.try({
    try: thunk,
    catch: (cause) => (isSetupError(cause) ? cause : new SetupFileError(operation, path, cause)),
  });
}

export function findExecutableEffect(ctx, command) {
  return fileEffect("find executable", command, () => {
    for (const directory of ctx.env.PATH?.split(delimiter) ?? []) {
      const candidate = resolve(ctx.repo, directory, command);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
      }
    }
    return undefined;
  });
}

export function managedFileEffect(path, blocks, label) {
  return fileEffect("update managed blocks", path, () => {
    const exists = existsSync(path);
    const current = exists ? readFileSync(path, "utf8") : "";
    const { next, changed: names } = reconcileNamedBlocks(
      current,
      blocks.map(({ name, source, enabled = true }) => ({
        name,
        body: enabled ? readFileSync(source, "utf8") : null,
      })),
    );
    if (names.length === 0) {
      ok(`${label} (managed blocks current)`);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    changed(`${label} (${exists ? "updated" : "created with"}: ${names.join(", ")})`);
  });
}

export function linkPathEffect(source, target, label) {
  return fileEffect("link path", target, () => {
    if (!existsSync(source)) throw new SetupStateError(`link source is missing: ${source}`);
    if (pathExistsOrIsSymlink(target)) {
      if (!lstatSync(target).isSymbolicLink()) {
        kept(label);
        return;
      }
      if (readlinkSync(target) === source) {
        ok(label);
        return;
      }
      unlinkSync(target);
      symlinkSync(source, target);
      relinked(label);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
    changed(label);
  });
}
