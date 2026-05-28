import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isObject, readSettingsBlock, type SettingsBlock } from "../_shared/settings";

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
  const settings = readSettingsBlock("playwrightClient", cwd);
  const profileName = envOrString("PI_BROWSER_PROFILE", settings.profileName) ?? "pi-browser-default";
  const profilePath = envOrString("PI_BROWSER_PROFILE_PATH", settings.profilePath) ?? join(homedir(), ".config", profileName);

  return {
    targets: loadTargets(settings),
    profileName,
    profilePath,
    artifactDir: envOrString("PI_BROWSER_ARTIFACT_DIR", settings.artifactDir) ?? join(tmpdir(), "pi-browser-artifacts"),
  };
}

function loadTargets(settings: SettingsBlock): BrowserTarget[] {
  const rawTargets = settings.targets;
  if (rawTargets === undefined) {
    return [normalizeTarget("local", {
      host: "127.0.0.1",
      port: DEFAULT_CDP_PORT,
      description: "Default local Chrome/CDP endpoint or SSH reverse-forward",
    })];
  }
  if (!isObject(rawTargets)) throw new Error("playwrightClient.targets must be an object keyed by target name");

  return Object.entries(rawTargets).map(([name, target]) => {
    if (!isObject(target)) throw new Error(`playwrightClient.targets.${name} must be an object with host and optional port/protocol/path`);
    return normalizeTarget(name, target);
  });
}

function normalizeTarget(name: string, settings: SettingsBlock): BrowserTarget {
  const host = asString(settings.host);
  if (!host) throw new Error(`playwrightClient.targets.${name}.host is required`);

  const port = asNumber(settings.port) ?? DEFAULT_CDP_PORT;
  const protocol = settings.protocol === "https" ? "https" : "http";
  if (settings.protocol !== undefined && settings.protocol !== "http" && settings.protocol !== "https") {
    throw new Error(`playwrightClient.targets.${name}.protocol must be http or https`);
  }

  const rawPath = asString(settings.path) ?? "";
  const path = rawPath && !rawPath.startsWith("/") ? `/${rawPath}` : rawPath;
  const description = asString(settings.description);

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

function envOrString(envKey: string, value: unknown): string | undefined {
  return process.env[envKey] ?? asString(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
