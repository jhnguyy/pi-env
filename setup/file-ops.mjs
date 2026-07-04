import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Effect } from 'effect';
import { ok, skip } from './runtime-support.mjs';

export function linked(message) { console.log(`  →  ${message}`); }
export function relink(message) { console.log(`  ↺  ${message} (relinked)`); }

export function pathExistsOrIsSymlink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function bootstrapFileEffect(src, dst, existsLabel, createdLabel) {
  return Effect.sync(() => {
    if (existsSync(dst)) {
      ok(existsLabel);
    } else {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      ok(createdLabel);
    }
  });
}

export function linkPathEffect(src, target, label) {
  return Effect.sync(() => {
    if (pathExistsOrIsSymlink(target)) {
      try {
        const current = readlinkSync(target);
        if (current === src) {
          ok(label);
          return;
        }
        unlinkSync(target);
        symlinkSync(src, target);
        relink(label);
        return;
      } catch {
        skip(label);
        return;
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(src, target);
    linked(label);
  });
}

export function appendOnceEffect(src, dst, marker, label) {
  return Effect.sync(() => {
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, `${marker}\n`);
      appendFileSync(dst, readFileSync(src));
      ok(`${label} (created with repo block)`);
    } else if (readFileSync(dst, 'utf8').includes(marker)) {
      ok(`${label} (repo block already present)`);
    } else {
      appendFileSync(dst, `\n${marker}\n`);
      appendFileSync(dst, readFileSync(src));
      ok(`${label} (appended repo block)`);
    }
  });
}
