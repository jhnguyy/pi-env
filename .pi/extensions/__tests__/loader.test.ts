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

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnabledExtensions } from "./test-utils";

const EXTENSIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Extension Loader", () => {
  const enabled = getEnabledExtensions();

  it("discovers at least one enabled extension", () => {
    expect(enabled.length).toBeGreaterThan(0);
  });

  for (const name of enabled) {
    describe(name, () => {
      it("exports a default function", async () => {
        const pkgPath = join(EXTENSIONS_DIR, name, "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { pi?: { extensions?: string[] } };
        const entry = pkg.pi?.extensions?.[0] ?? "./dist/index.js";
        const mod = await import(join(EXTENSIONS_DIR, name, entry));
        expect(typeof mod.default).toBe("function");
      }, 15_000);

      it("accepts one argument (pi: ExtensionAPI)", async () => {
        const pkgPath = join(EXTENSIONS_DIR, name, "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { pi?: { extensions?: string[] } };
        const entry = pkg.pi?.extensions?.[0] ?? "./dist/index.js";
        const mod = await import(join(EXTENSIONS_DIR, name, entry));
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
