import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
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

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// Earlier setup wrote links from the shell's logical checkout path, which can differ from the
// physical path Node reports. Match either spelling, or the same resolved file.
export function isLinkTo(target, sources) {
  if (!pathExistsOrIsSymlink(target) || !lstatSync(target).isSymbolicLink()) return false;
  const current = readlinkSync(target);
  if (sources.includes(current)) return true;
  const resolved = realpathOrNull(target);
  return resolved !== null && sources.some((source) => realpathOrNull(source) === resolved);
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
      blocks.map(({ name, source }) => ({ name, body: readFileSync(source, "utf8") })),
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

// Remove only links that still point at a source setup created; anything else is user-owned.
export function removeOwnedLinkEffect(sources, target, label) {
  return fileEffect("remove obsolete link", target, () => {
    if (!pathExistsOrIsSymlink(target)) return;
    if (!isLinkTo(target, sources)) {
      kept(label);
      return;
    }
    unlinkSync(target);
    changed(`${label} (obsolete link removed)`);
  });
}

export function removeEmptyDirectoryEffect(path, label) {
  return fileEffect("remove obsolete directory", path, () => {
    if (!pathExistsOrIsSymlink(path) || !lstatSync(path).isDirectory()) return;
    if (readdirSync(path).length > 0) return;
    rmdirSync(path);
    changed(`${label} (empty obsolete directory removed)`);
  });
}
