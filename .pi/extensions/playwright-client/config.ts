import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface BrowserTarget {
  name: string;
  cdpUrl: string;
  description?: string;
}

export interface BrowserClientConfig {
  cdpUrl: string;
  targetName: string;
  targets: BrowserTarget[];
  profileName: string;
  profilePath: string;
  artifactDir: string;
}

const DEFAULT_CDP_PORT = "9222";

export function loadBrowserClientConfig(): BrowserClientConfig {
  const settings = loadSettingsConfig();
  const profileName = process.env.PI_BROWSER_PROFILE ?? stringAt(settings, "profileName") ?? "pi-browser-default";
  const profilePath = process.env.PI_BROWSER_PROFILE_PATH ?? stringAt(settings, "profilePath") ?? join(homedir(), ".config", profileName);
  const targets = loadTargets(settings);
  const selectedTarget = selectTarget(targets, settings);

  return {
    cdpUrl: selectedTarget.cdpUrl,
    targetName: selectedTarget.name,
    targets,
    profileName,
    profilePath,
    artifactDir: process.env.PI_BROWSER_ARTIFACT_DIR ?? stringAt(settings, "artifactDir") ?? join(tmpdir(), "pi-browser-artifacts"),
  };
}

function loadTargets(settings: Record<string, unknown>): BrowserTarget[] {
  const targets = new Map<string, BrowserTarget>();
  for (const target of builtinTargets()) targets.set(target.name, target);
  for (const target of parseTargetsConfig(settings.targets)) targets.set(target.name, target);
  for (const target of parseTargetsEnv(process.env.PI_BROWSER_TARGETS)) targets.set(target.name, target);

  const settingsUrl = stringAt(settings, "cdpUrl");
  if (settingsUrl) {
    targets.set("settings", { name: "settings", cdpUrl: settingsUrl, description: "playwrightClient.cdpUrl from settings.json" });
  }

  const settingsHost = stringAt(settings, "cdpHost");
  if (settingsHost) {
    targets.set("settings-host", {
      name: "settings-host",
      cdpUrl: toCdpUrl(settingsHost, stringAt(settings, "cdpPort") ?? DEFAULT_CDP_PORT),
      description: "playwrightClient.cdpHost/playwrightClient.cdpPort from settings.json",
    });
  }

  const explicitUrl = process.env.PI_BROWSER_CDP_URL;
  if (explicitUrl) {
    targets.set("env", { name: "env", cdpUrl: explicitUrl, description: "PI_BROWSER_CDP_URL" });
  }

  const explicitHost = process.env.PI_BROWSER_CDP_HOST;
  if (explicitHost) {
    const port = process.env.PI_BROWSER_CDP_PORT ?? DEFAULT_CDP_PORT;
    targets.set("env-host", {
      name: "env-host",
      cdpUrl: toCdpUrl(explicitHost, port),
      description: "PI_BROWSER_CDP_HOST/PI_BROWSER_CDP_PORT",
    });
  }

  return [...targets.values()];
}

function builtinTargets(): BrowserTarget[] {
  return [
    { name: "local", cdpUrl: "http://127.0.0.1:9222", description: "Chrome/CDP on this host or an SSH reverse-forward" },
    { name: "docker-host", cdpUrl: "http://host.docker.internal:9222", description: "Host browser from Docker/Colima containers" },
    { name: "colima", cdpUrl: "http://host.docker.internal:9222", description: "macOS host Google Chrome from a Colima container" },
  ];
}

function selectTarget(targets: BrowserTarget[], settings: Record<string, unknown>): BrowserTarget {
  if (process.env.PI_BROWSER_CDP_URL) return targetByName(targets, "env");
  if (process.env.PI_BROWSER_CDP_HOST) return targetByName(targets, "env-host");
  if (stringAt(settings, "cdpUrl")) return targetByName(targets, "settings");
  if (stringAt(settings, "cdpHost")) return targetByName(targets, "settings-host");
  const targetName = process.env.PI_BROWSER_TARGET ?? stringAt(settings, "target") ?? "local";
  return targetByName(targets, targetName);
}

function targetByName(targets: BrowserTarget[], name: string): BrowserTarget {
  const target = targets.find((candidate) => candidate.name === name);
  if (!target) {
    throw new Error(`Unknown browser target ${name}. Available targets: ${targets.map((candidate) => candidate.name).join(", ")}`);
  }
  return target;
}

function loadSettingsConfig(): Record<string, unknown> {
  const agentSettings = readJsonIfExists(join(homedir(), ".pi", "agent", "settings.json"));
  const projectSettings = readJsonIfExists(join(process.cwd(), ".pi", "settings.json"));
  return {
    ...objectAt(agentSettings, "playwrightClient"),
    ...objectAt(projectSettings, "playwrightClient"),
  };
}

function parseTargetsConfig(raw: unknown): BrowserTarget[] {
  if (raw === undefined) return [];
  return parseTargets(raw, "playwrightClient.targets");
}

function parseTargetsEnv(raw: string | undefined): BrowserTarget[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`PI_BROWSER_TARGETS must be JSON: ${formatError(error)}`);
  }
  return parseTargets(parsed, "PI_BROWSER_TARGETS");
}

function parseTargets(parsed: unknown, label: string): BrowserTarget[] {
  if (Array.isArray(parsed)) {
    return parsed.map((value) => normalizeTarget(value));
  }

  if (isRecord(parsed)) {
    return Object.entries(parsed).map(([name, value]) => {
      if (typeof value === "string") return normalizeTarget({ name, cdpUrl: value });
      return normalizeTarget({ name, ...asRecord(value) });
    });
  }

  throw new Error(`${label} must be a JSON object or array`);
}

function normalizeTarget(value: unknown): BrowserTarget {
  const record = asRecord(value);
  const name = stringField(record, "name");
  const cdpUrl = typeof record.cdpUrl === "string"
    ? record.cdpUrl
    : toCdpUrl(stringField(record, "host"), stringAt(record, "port") ?? DEFAULT_CDP_PORT);
  const description = typeof record.description === "string" ? record.description : undefined;
  return { name, cdpUrl, description };
}

function toCdpUrl(host: string, port: string): string {
  if (host.startsWith("http://") || host.startsWith("https://")) return host;
  return `http://${host}:${port}`;
}

function readJsonIfExists(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return isRecord(value) ? value : {};
}

function stringAt(root: Record<string, unknown>, key: string): string | undefined {
  const value = root[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = stringAt(record, field);
  if (!value) throw new Error(`Browser target requires string field ${field}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Browser target must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
