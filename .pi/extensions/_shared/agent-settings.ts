import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

export interface AgentSettings {
  enabledModels?: string[];
  modelAnnotations?: Record<string, string[]>;
  workTracker?: {
    repos?: string[];
    protectedBranches?: string[];
  };
  extensions?: string[];
}

export interface AgentSettingsEnv {
  settingsPath(): string;
  readFile(path: string, encoding: BufferEncoding): string;
}

export interface AgentSettingsReadError {
  readonly _tag: "AgentSettingsReadError";
  readonly path: string;
  readonly cause: unknown;
}

const defaultEnv: AgentSettingsEnv = {
  settingsPath: () => join(getAgentDir(), "settings.json"),
  readFile: readFileSync,
};

function asAgentSettings(value: unknown): AgentSettings {
  return value !== null && typeof value === "object" ? value as AgentSettings : {};
}

export function readAgentSettingsEffect(
  env: AgentSettingsEnv = defaultEnv,
): Effect.Effect<AgentSettings, AgentSettingsReadError> {
  return Effect.try({
    try: () => {
      const path = env.settingsPath();
      return asAgentSettings(JSON.parse(env.readFile(path, "utf-8")));
    },
    catch: (cause) => ({
      _tag: "AgentSettingsReadError" as const,
      path: safeSettingsPath(env),
      cause,
    }),
  });
}

export function readOptionalAgentSettingsEffect(
  env: AgentSettingsEnv = defaultEnv,
): Effect.Effect<AgentSettings | null> {
  return Effect.catchAll(readAgentSettingsEffect(env), () => Effect.succeed(null));
}

export function readOptionalAgentSettings(env: AgentSettingsEnv = defaultEnv): AgentSettings | null {
  return Effect.runSync(readOptionalAgentSettingsEffect(env));
}

function safeSettingsPath(env: AgentSettingsEnv): string {
  try {
    return env.settingsPath();
  } catch {
    return "<unresolved>";
  }
}
