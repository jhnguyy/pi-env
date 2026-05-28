import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

type TargetSettings = Record<string, unknown>;
type PlaywrightClientSettings = Record<string, unknown>;

export function loadBrowserClientConfig(): BrowserClientConfig {
  const settings = loadSettingsConfig();
  const profileName = process.env.PI_BROWSER_PROFILE ?? stringAt(settings, "profileName") ?? "pi-browser-default";
  const profilePath = process.env.PI_BROWSER_PROFILE_PATH ?? stringAt(settings, "profilePath") ?? join(homedir(), ".config", profileName);

  return {
    targets: loadTargets(settings),
    profileName,
    profilePath,
    artifactDir: process.env.PI_BROWSER_ARTIFACT_DIR ?? stringAt(settings, "artifactDir") ?? join(tmpdir(), "pi-browser-artifacts"),
  };
}

function loadTargets(settings: PlaywrightClientSettings): BrowserTarget[] {
  return Object.entries({
    ...builtinTargetSettings(),
    ...targetsAt(settings, "targets", "playwrightClient.targets"),
  }).map(([name, target]) => normalizeTarget(name, target));
}

function builtinTargetSettings(): Record<string, TargetSettings> {
  return {
    local: {
      host: "127.0.0.1",
      port: DEFAULT_CDP_PORT,
      description: "Chrome/CDP on this host or an SSH reverse-forward",
    },
    "docker-host": {
      host: "host.docker.internal",
      port: DEFAULT_CDP_PORT,
      description: "Host browser from Docker/Colima containers",
    },
    colima: {
      host: "host.docker.internal",
      port: DEFAULT_CDP_PORT,
      description: "macOS host Google Chrome from a Colima container",
    },
  };
}

function loadSettingsConfig(): PlaywrightClientSettings {
  const agentSettings = readJsonIfExists(join(homedir(), ".pi", "agent", "settings.json"));
  const projectSettings = readJsonIfExists(join(process.cwd(), ".pi", "settings.json"));
  return {
    ...objectAt(agentSettings, "playwrightClient"),
    ...objectAt(projectSettings, "playwrightClient"),
  };
}

function targetsAt(root: Record<string, unknown>, key: string, label: string): Record<string, TargetSettings> {
  const value = root[key];
  if (value === undefined) return {};
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`${label} must be an object keyed by target name`);

  const targets: Record<string, TargetSettings> = {};
  for (const [name, target] of Object.entries(value)) {
    if (!isRecord(target) || Array.isArray(target)) {
      throw new Error(`${label}.${name} must be an object with host and optional port/protocol/path`);
    }
    targets[name] = target;
  }
  return targets;
}

function normalizeTarget(name: string, settings: TargetSettings): BrowserTarget {
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

function readJsonIfExists(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return isRecord(value) ? value : {};
}

function requiredString(root: Record<string, unknown>, key: string, label: string): string {
  const value = stringAt(root, key);
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function stringAt(root: Record<string, unknown>, key: string): string | undefined {
  const value = root[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAt(root: Record<string, unknown>, key: string): number | undefined {
  const value = root[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function protocolAt(root: Record<string, unknown>, key: string): "http" | "https" | undefined {
  const value = stringAt(root, key);
  if (value === undefined) return undefined;
  if (value === "http" || value === "https") return value;
  throw new Error(`${key} must be http or https`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
