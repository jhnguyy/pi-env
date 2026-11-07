import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Schema } from "effect";
import { readSettingsBlock, type SettingsBlock } from "../_shared/settings";

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

class BrowserConfigError extends Data.TaggedError("BrowserConfigError")<{
  readonly path: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.path}: ${this.reason}`;
  }
}

const TargetSettingsSchema = Schema.Struct({
  host: Schema.String,
  port: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  protocol: Schema.optionalKey(Schema.Literals(["http", "https"])),
  path: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});
const TargetsSchema = Schema.Record(Schema.String, TargetSettingsSchema);
type TargetSettings = typeof TargetSettingsSchema.Type;

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

  const targets = decodeTargets(rawTargets);
  return Object.entries(targets).map(([name, target]) => normalizeTarget(name, target));
}

function decodeTargets(rawTargets: unknown): Record<string, TargetSettings> {
  try {
    return Schema.decodeUnknownSync(TargetsSchema)(rawTargets);
  } catch (cause) {
    throw new BrowserConfigError({
      path: "playwrightClient.targets",
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function normalizeTarget(name: string, settings: TargetSettings): BrowserTarget {
  const host = settings.host;
  if (host.length === 0) {
    throw new BrowserConfigError({ path: `playwrightClient.targets.${name}.host`, reason: "is required" });
  }

  const port = asNumber(settings.port) ?? DEFAULT_CDP_PORT;
  const protocol = settings.protocol ?? "http";
  const rawPath = settings.path ?? "";
  const path = rawPath && !rawPath.startsWith("/") ? `/${rawPath}` : rawPath;
  const description = settings.description;

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
