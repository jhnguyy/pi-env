/**
 * Shared test utilities for extension testing.
 *
 * Provides helpers to check if an extension is enabled in settings.json
 * so tests can skip themselves when their extension is disabled.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { describe } from "bun:test";

const EXTENSIONS_DIR = resolve(import.meta.dir, "..");
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

interface Settings {
  extensions?: string[];
}

let _disabledCache: Set<string> | null = null;

/** Returns the set of explicitly disabled extension names (normalized, no prefix/suffix). */
function getDisabledExtensions(): Set<string> {
  if (_disabledCache) return _disabledCache;

  const disabled = new Set<string>();

  if (existsSync(SETTINGS_PATH)) {
    try {
      const settings: Settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      for (const entry of settings.extensions ?? []) {
        if (entry.startsWith("-")) {
          const name = entry
            .replace(/^-/, "")
            .replace(/^extensions\//, "")
            .replace(/\.ts$/, "")
            .replace(/\/index$/, "");
          disabled.add(name);
        }
      }
    } catch {
      // If settings can't be read, assume nothing is disabled
    }
  }

  _disabledCache = disabled;
  return disabled;
}

/**
 * Check if an extension is enabled.
 *
 * An extension is enabled if:
 * - It exists as a directory with index.ts
 * - It is NOT listed with a `-` prefix in settings.json
 */
export function isExtensionEnabled(name: string): boolean {
  return !getDisabledExtensions().has(name);
}

/**
 * Returns the list of enabled extension directory names.
 */
export function getEnabledExtensions(): string[] {
  const disabled = getDisabledExtensions();
  const enabled: string[] = [];

  for (const entry of readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "docs") continue;

    const indexPath = join(EXTENSIONS_DIR, entry.name, "index.ts");
    if (!existsSync(indexPath)) continue;
    if (disabled.has(entry.name)) continue;

    enabled.push(entry.name);
  }

  return enabled;
}

/**
 * Helper for use at the top of test files in extension __tests__ directories.
 * Returns a describe that skips all tests if the extension is disabled.
 *
 * Usage:
 *   import { describeIfEnabled } from "../../__tests__/test-utils";
 *   describeIfEnabled("permissions", "CredentialScanner", () => { ... });
 */
export function describeIfEnabled(
  extensionName: string,
  suiteName: string,
  fn: () => void,
): void {
  if (isExtensionEnabled(extensionName)) {
    describe(suiteName, fn);
  } else {
    describe.skip(suiteName, fn);
  }
}
