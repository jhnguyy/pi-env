import { Effect, Schema } from "effect";
import {
  SettingsDecodeError,
  SettingsSource,
  defaultSettingsEnv,
  loadSettingsSnapshotEffect,
  type SettingsEnv,
  type SettingsError,
  type SettingsSnapshot,
} from "./settings";

const StringArraySchema = Schema.mutable(Schema.Array(Schema.String));

export const WorkTrackerSettingsSchema = Schema.Struct({
  repos: Schema.optional(StringArraySchema),
  protectedBranches: Schema.optional(StringArraySchema),
});

export const AgentSettingsSchema = Schema.Struct({
  enabledModels: Schema.optional(StringArraySchema),
  modelAnnotations: Schema.optional(Schema.Record(Schema.String, StringArraySchema)),
  workTracker: Schema.optional(WorkTrackerSettingsSchema),
  extensions: Schema.optional(StringArraySchema),
});

export type AgentSettings = typeof AgentSettingsSchema.Type;
export type WorkTrackerSettings = typeof WorkTrackerSettingsSchema.Type;
export type AgentSettingsEnv = SettingsEnv;
export type AgentSettingsReadError = SettingsError;

export function readAgentSettingsEffect(
  env: AgentSettingsEnv = defaultSettingsEnv,
  cwd = process.cwd(),
): Effect.Effect<AgentSettings, AgentSettingsReadError> {
  return Effect.flatMap(loadSettingsSnapshotEffect(cwd, env), decodeAgentSettingsSnapshotEffect);
}

function readOptionalAgentSettingsEffect(
  env: AgentSettingsEnv = defaultSettingsEnv,
  cwd = process.cwd(),
): Effect.Effect<AgentSettings | null> {
  return Effect.catch(
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

function decodeAgentSettingsSnapshotEffect(
  snapshot: SettingsSnapshot,
): Effect.Effect<AgentSettings, SettingsDecodeError> {
  return Schema.decodeUnknownEffect(AgentSettingsSchema)(snapshot.merged).pipe(
    Effect.mapError((cause) => new SettingsDecodeError({
      source: SettingsSource.Overlay,
      path: `${snapshot.paths.global} + ${snapshot.paths.project}`,
      paths: snapshot.paths,
      cause,
    })),
  );
}
