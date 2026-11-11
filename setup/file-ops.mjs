import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
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

export function managedFileEffect(path, blocks, label) {
  return fileEffect("update managed blocks", path, () => {
    const exists = existsSync(path);
    const current = exists ? readFileSync(path, "utf8") : "";
    const { next, changed: names } = reconcileNamedBlocks(
      current,
      blocks.map(({ name, sources }) => ({
        name,
        body: sources.map((source) => readFileSync(source, "utf8").trim()).join("\n\n"),
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
