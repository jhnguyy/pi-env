/**
 * @module _shared/settings
 * @purpose Read extension-specific settings blocks from pi settings.json files.
 *
 * Convention: ~/.pi/agent/settings.json provides global defaults and
 * <cwd>/.pi/settings.json overrides them for a project. Validation stays in
 * each extension because each settings block has different semantics.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SettingsBlock = Record<string, unknown>;

export function readSettingsBlock(key: string, cwd = process.cwd()): SettingsBlock {
  return {
    ...objectAt(readJsonObject(join(getAgentDir(), "settings.json")), key),
    ...objectAt(readJsonObject(join(cwd, ".pi", "settings.json")), key),
  };
}

function readJsonObject(path: string): SettingsBlock {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return isObject(parsed) ? parsed : {};
}

export function objectAt(root: SettingsBlock, key: string): SettingsBlock {
  const value = root[key];
  return isObject(value) ? value : {};
}

export function parseBooleanSetting(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return undefined;
}

export function booleanSetting(value: unknown, envValue: unknown, defaultValue: boolean): boolean {
  return parseBooleanSetting(envValue) ?? parseBooleanSetting(value) ?? defaultValue;
}

export function positiveIntegerSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function isObject(value: unknown): value is SettingsBlock {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
