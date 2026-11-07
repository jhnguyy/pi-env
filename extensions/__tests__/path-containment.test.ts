import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathContained } from "../_shared/path-containment";
import * as TempDir from "../../src/testing/temp-dir";

describe("canonical path containment", () => {
  it("rejects a symlinked directory that resolves outside the root", () => {
    const fixture = TempDir.forTestSync("path-containment-");
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
