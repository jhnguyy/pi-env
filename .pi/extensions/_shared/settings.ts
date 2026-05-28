/**
 * @module _shared/settings
 * @purpose Small helpers for pi-env extension settings.json access and unknown-value narrowing.
 *
 * Extension config convention:
 *   - Global settings live in ~/.pi/agent/settings.json under an extension-specific key.
 *   - Project settings live in <cwd>/.pi/settings.json under the same key.
 *   - Project settings override global settings when both are present.
 *
 * Keep extension-specific validation in the extension; this module only handles
 * safe JSON/object access and primitive coercion shared across extensions.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SettingsRecord = Record<string, unknown>;

export function readJsonObjectIfExists(path: string): SettingsRecord {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : {};
}

export function readExtensionSettings(key: string, cwd = process.cwd()): SettingsRecord {
  const globalSettings = readJsonObjectIfExists(join(getAgentDir(), "settings.json"));
  const projectSettings = readJsonObjectIfExists(join(cwd, ".pi", "settings.json"));
  return {
    ...recordAt(globalSettings, key),
    ...recordAt(projectSettings, key),
  };
}

export function recordAt(root: SettingsRecord, key: string): SettingsRecord {
  const value = root[key];
  return isRecord(value) ? value : {};
}

export function requiredString(root: SettingsRecord, key: string, label: string): string {
  const value = stringAt(root, key);
  if (!value) throw new Error(`${label} is required`);
  return value;
}

export function stringAt(root: SettingsRecord, key: string): string | undefined {
  const value = root[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberAt(root: SettingsRecord, key: string): number | undefined {
  const value = root[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function booleanAt(root: SettingsRecord, key: string): boolean | undefined {
  const value = root[key];
  return typeof value === "boolean" ? value : undefined;
}

export function isRecord(value: unknown): value is SettingsRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
