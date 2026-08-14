import { Effect, Schema } from "effect";
import {
  SettingsDecodeError,
  SettingsSource,
  isObject,
  loadSettingsSnapshotEffect,
  type SettingsEnv,
  type SettingsError,
} from "../_shared/settings";
export const CREDENTIAL_SOURCE_SETTINGS_KEY = "credentialSource";

const CredentialNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][A-Za-z0-9-]*)+$/),
);
const OnePasswordEntrySchema = Schema.Struct({
  provider: Schema.Literal("1password"),
  consumers: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))).check(
    Schema.isNonEmpty(),
  ),
  reference: Schema.String.check(
    Schema.isPattern(/^op:\/\/[^/\s]+\/[^/\s]+\/(?:[^/\s]+\/)?[^/\s]+$/),
  ),
});
const BitwardenEntrySchema = Schema.Struct({
  provider: Schema.Literal("bitwarden"),
  consumers: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))).check(
    Schema.isNonEmpty(),
  ),
  itemId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  ),
  field: Schema.Literal("password"),
});

export const CredentialEntrySchema = Schema.Union([OnePasswordEntrySchema, BitwardenEntrySchema]);

export const CredentialSourceSettingsSchema = Schema.Struct({
  entries: Schema.Record(CredentialNameSchema, CredentialEntrySchema),
});

export type CredentialEntry = typeof CredentialEntrySchema.Type;
export type CredentialSourceSettings = typeof CredentialSourceSettingsSchema.Type;

export function loadCredentialSourceSettingsEffect(
  cwd = process.cwd(),
  env?: SettingsEnv,
): Effect.Effect<CredentialSourceSettings, SettingsError> {
  return Effect.flatMap(loadSettingsSnapshotEffect(cwd, env), (snapshot) => {
    if (CREDENTIAL_SOURCE_SETTINGS_KEY in snapshot.project) {
      return Effect.fail(
        new SettingsDecodeError({
          source: SettingsSource.Project,
          path: snapshot.paths.project,
          key: CREDENTIAL_SOURCE_SETTINGS_KEY,
          paths: snapshot.paths,
          cause: "Project settings cannot define credential source mappings.",
        }),
      );
    }
    const raw = snapshot.global[CREDENTIAL_SOURCE_SETTINGS_KEY] ?? { entries: {} };
    if (!isObject(raw)) {
      return Effect.fail(
        new SettingsDecodeError({
          source: SettingsSource.Global,
          path: snapshot.paths.global,
          key: CREDENTIAL_SOURCE_SETTINGS_KEY,
          paths: snapshot.paths,
          cause: raw,
        }),
      );
    }
    return Schema.decodeUnknownEffect(CredentialSourceSettingsSchema, {
      errors: "all",
      onExcessProperty: "error",
    })(raw).pipe(
      Effect.mapError(
        (cause) =>
          new SettingsDecodeError({
            source: SettingsSource.Global,
            path: snapshot.paths.global,
            key: CREDENTIAL_SOURCE_SETTINGS_KEY,
            paths: snapshot.paths,
            cause,
          }),
      ),
    );
  });
}
