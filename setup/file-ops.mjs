import {
  appendFileSync,
  copyFileSync,
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
import { reconcileManagedBlock } from "./managed-block.mjs";
import { Effect } from "effect";
import { ok, skip } from "./runtime-support.mjs";
import { isSetupError, SetupFileError } from "./setup-errors.mjs";

export function linked(message) {
  console.log(`  →  ${message}`);
}
export function relink(message) {
  console.log(`  ↺  ${message}. Symbolic link updated.`);
}

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

export function bootstrapFileEffect(src, dst, existsLabel, createdLabel) {
  return fileEffect("bootstrap file", dst, () => {
    if (existsSync(dst)) {
      ok(existsLabel);
    } else {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      ok(createdLabel);
    }
  });
}

export { reconcileManagedBlock } from "./managed-block.mjs";

export function managedBlockEffect(src, dst, startMarker, endMarker, label) {
  return fileEffect("update managed block", dst, () => {
    const exists = existsSync(dst);
    const current = exists ? readFileSync(dst, "utf8") : "";
    const managed = readFileSync(src, "utf8");
    const next = reconcileManagedBlock(current, managed, startMarker, endMarker);

    if (next === current) {
      ok(`${label} (managed block current)`);
      return;
    }
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, next);
    linked(`${label} (${exists ? "managed block updated" : "created with managed block"})`);
  });
}

export function linkPathEffect(src, target, label) {
  return fileEffect("link path", target, () => {
    if (pathExistsOrIsSymlink(target)) {
      if (!lstatSync(target).isSymbolicLink()) {
        skip(label);
        return;
      }
      const current = readlinkSync(target);
      if (current === src) {
        ok(label);
        return;
      }
      unlinkSync(target);
      symlinkSync(src, target);
      relink(label);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(src, target);
    linked(label);
  });
}

export function appendOnceEffect(src, dst, marker, label) {
  return fileEffect("append file", dst, () => {
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, `${marker}\n`);
      appendFileSync(dst, readFileSync(src));
      ok(`${label} (created with repo block)`);
    } else if (readFileSync(dst, "utf8").includes(marker)) {
      ok(`${label} (repo block already present)`);
    } else {
      appendFileSync(dst, `\n${marker}\n`);
      appendFileSync(dst, readFileSync(src));
      ok(`${label} (appended repo block)`);
    }
  });
}
