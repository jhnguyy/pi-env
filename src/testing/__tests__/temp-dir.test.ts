import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as TempDir from "../temp-dir";

// Removal happens after a test finishes, so each case observes the previous test's directory.
describe.each([
  ["forTest", () => TempDir.forTest("temp-dir-async-")],
  ["forTestSync", () => TempDir.forTestSync("temp-dir-sync-")],
])("TempDir.%s", (_name, create) => {
  let created = "";

  it("provides a writable directory for the current test", async () => {
    created = await create();
    writeFileSync(join(created, "file.txt"), "content");
    expect(existsSync(join(created, "file.txt"))).toBe(true);
  });

  it("removes the directory and its contents after that test finishes", () => {
    expect(created).not.toBe("");
    expect(existsSync(created)).toBe(false);
  });
});
