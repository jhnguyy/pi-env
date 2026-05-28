import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRecord,
  numberAt,
  readExtensionSettings,
  requiredString,
  stringAt,
  type SettingsRecord,
} from "../_shared/settings";

export interface BrowserTarget {
  name: string;
  host: string;
  port: number;
  protocol: "http" | "https";
  path: string;
  cdpUrl: string;
  description?: string;
}

export interface BrowserClientConfig {
  targets: BrowserTarget[];
  profileName: string;
  profilePath: string;
  artifactDir: string;
}

const DEFAULT_CDP_PORT = 9222;

export function loadBrowserClientConfig(cwd = process.cwd()): BrowserClientConfig {
  const settings = readExtensionSettings("playwrightClient", cwd);
  const profileName = process.env.PI_BROWSER_PROFILE ?? stringAt(settings, "profileName") ?? "pi-browser-default";
  const profilePath = process.env.PI_BROWSER_PROFILE_PATH ?? stringAt(settings, "profilePath") ?? join(homedir(), ".config", profileName);

  return {
    targets: loadTargets(settings),
    profileName,
    profilePath,
    artifactDir: process.env.PI_BROWSER_ARTIFACT_DIR ?? stringAt(settings, "artifactDir") ?? join(tmpdir(), "pi-browser-artifacts"),
  };
}

function loadTargets(settings: SettingsRecord): BrowserTarget[] {
  const configured = targetsAt(settings, "targets", "playwrightClient.targets");
  const targetSettings = Object.keys(configured).length > 0
    ? configured
    : { local: { host: "127.0.0.1", port: DEFAULT_CDP_PORT, description: "Default local Chrome/CDP endpoint or SSH reverse-forward" } };

  return Object.entries(targetSettings).map(([name, target]) => normalizeTarget(name, target));
}

function targetsAt(root: SettingsRecord, key: string, label: string): Record<string, SettingsRecord> {
  const value = root[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object keyed by target name`);

  const targets: Record<string, SettingsRecord> = {};
  for (const [name, target] of Object.entries(value)) {
    if (!isRecord(target)) throw new Error(`${label}.${name} must be an object with host and optional port/protocol/path`);
    targets[name] = target;
  }
  return targets;
}

function normalizeTarget(name: string, settings: SettingsRecord): BrowserTarget {
  const host = requiredString(settings, "host", `playwrightClient.targets.${name}.host`);
  const port = numberAt(settings, "port") ?? DEFAULT_CDP_PORT;
  const protocol = protocolAt(settings, "protocol") ?? "http";
  const path = normalizePath(stringAt(settings, "path") ?? "");
  const description = stringAt(settings, "description");
  return {
    name,
    host,
    port,
    protocol,
    path,
    cdpUrl: `${protocol}://${host}:${port}${path}`,
    description,
  };
}

function normalizePath(path: string): string {
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function protocolAt(root: SettingsRecord, key: string): "http" | "https" | undefined {
  const value = stringAt(root, key);
  if (value === undefined) return undefined;
  if (value === "http" || value === "https") return value;
  throw new Error(`${key} must be http or https`);
}
