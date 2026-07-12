import { Effect, Schema } from "effect";
import {
  SettingsDecodeError,
  SettingsSource,
  defaultSettingsEnv,
  loadSettingsSnapshotEffect,
  settingsPaths,
  type SettingsEnv,
  type SettingsError,
  type SettingsSnapshot,
} from "./settings";

const StringArraySchema = Schema.mutable(Schema.Array(Schema.String));

export const WorkTrackerSettingsSchema = Schema.mutable(Schema.Struct({
  repos: Schema.optional(StringArraySchema),
  protectedBranches: Schema.optional(StringArraySchema),
}));

export const AgentSettingsSchema = Schema.mutable(Schema.Struct({
  enabledModels: Schema.optional(StringArraySchema),
  modelAnnotations: Schema.optional(Schema.Record({ key: Schema.String, value: StringArraySchema })),
  workTracker: Schema.optional(WorkTrackerSettingsSchema),
  extensions: Schema.optional(StringArraySchema),
}));

export type AgentSettings = Schema.Schema.Type<typeof AgentSettingsSchema>;
export type WorkTrackerSettings = Schema.Schema.Type<typeof WorkTrackerSettingsSchema>;
export type AgentSettingsEnv = SettingsEnv;
export type AgentSettingsReadError = SettingsError;

export function readAgentSettingsEffect(
  env: AgentSettingsEnv = defaultSettingsEnv,
  cwd = process.cwd(),
): Effect.Effect<AgentSettings, AgentSettingsReadError> {
  return Effect.flatMap(loadSettingsSnapshotEffect(cwd, env), decodeAgentSettingsSnapshotEffect);
}

export function readOptionalAgentSettingsEffect(
  env: AgentSettingsEnv = defaultSettingsEnv,
  cwd = process.cwd(),
): Effect.Effect<AgentSettings | null> {
  return Effect.catchAll(
    Effect.flatMap(loadSettingsSnapshotEffect(cwd, env), (snapshot) => {
      if (!snapshot.exists.global && !snapshot.exists.project) return Effect.succeed(null);
      return decodeAgentSettingsSnapshotEffect(snapshot);
    }),
    () => Effect.succeed(null),
  );
}

export function readOptionalAgentSettings(env: AgentSettingsEnv = defaultSettingsEnv, cwd = process.cwd()): AgentSettings | null {
  return Effect.runSync(readOptionalAgentSettingsEffect(env, cwd));
}

export function agentSettingsPaths(env: AgentSettingsEnv = defaultSettingsEnv, cwd = process.cwd()): { global: string; project: string } {
  return settingsPaths(cwd, env);
}

function decodeAgentSettingsSnapshotEffect(
  snapshot: SettingsSnapshot,
): Effect.Effect<AgentSettings, SettingsDecodeError> {
  return Schema.decodeUnknown(AgentSettingsSchema)(snapshot.merged).pipe(
    Effect.mapError((cause) => new SettingsDecodeError({
      source: SettingsSource.Overlay,
      path: `${snapshot.paths.global} + ${snapshot.paths.project}`,
      paths: snapshot.paths,
      cause,
    })),
  );
}
