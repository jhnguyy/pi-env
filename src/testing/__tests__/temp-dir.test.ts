import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import * as TempDir from "../temp-dir";

describe.each([
  ["forTest", () => TempDir.forTest("temp-dir-async-")],
  ["forTestSync", () => TempDir.forTestSync("temp-dir-sync-")],
])("TempDir.%s", (_name, create) => {
  it("provides a writable directory and removes it with its contents after the test", async () => {
    let created = "";
    // Registered before the directory exists, so it runs after the helper disposes it.
    onTestFinished(() => {
      expect(created).not.toBe("");
      expect(existsSync(created)).toBe(false);
    });

    created = await create();
    writeFileSync(join(created, "file.txt"), "content");
    expect(existsSync(join(created, "file.txt"))).toBe(true);
  });
});
