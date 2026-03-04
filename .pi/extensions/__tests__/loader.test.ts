/**
 * Extension loader — validates all enabled extensions:
 *   1. Can be imported without errors
 *   2. Export a default function (the extension entry point)
 *   3. Have at least one test file
 *
 * Reads ~/.pi/agent/settings.json to determine which extensions are enabled.
 * Disabled extensions (prefixed with `-`) are skipped entirely.
 *
 * Run after adding or building an extension to confirm it's wired up correctly.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getEnabledExtensions } from "./test-utils";

const EXTENSIONS_DIR = resolve(import.meta.dir, "..");

describe("Extension Loader", () => {
  const enabled = getEnabledExtensions();

  it("discovers at least one enabled extension", () => {
    expect(enabled.length).toBeGreaterThan(0);
  });

  for (const name of enabled) {
    describe(name, () => {
      it("exports a default function", async () => {
        const mod = await import(join(EXTENSIONS_DIR, name, "index.ts"));
        expect(typeof mod.default).toBe("function");
      });

      it("accepts one argument (pi: ExtensionAPI)", async () => {
        const mod = await import(join(EXTENSIONS_DIR, name, "index.ts"));
        expect(mod.default.length).toBe(1);
      });

      it("has at least one test file", () => {
        const testDir = join(EXTENSIONS_DIR, name, "__tests__");
        expect(existsSync(testDir)).toBe(true);
        const tests = readdirSync(testDir).filter((f) => f.endsWith(".test.ts"));
        expect(tests.length).toBeGreaterThan(0);
      });
    });
  }
});
