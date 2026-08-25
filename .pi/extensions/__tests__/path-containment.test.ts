import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPathContained } from "../_shared/path-containment";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical path containment", () => {
  it("rejects a symlinked directory that resolves outside the root", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "path-containment-"));
    roots.push(fixture);
    const root = path.join(fixture, "root");
    const outside = path.join(fixture, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    const link = path.join(root, "link");
    symlinkSync(outside, link, "dir");

    expect(isPathContained(root, link)).toBe(false);
    expect(isPathContained(root, root)).toBe(true);
  });
});
