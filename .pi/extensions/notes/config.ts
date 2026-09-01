import { Effect, Schema } from "effect";

import {
  decodeSettingsBlockFromSnapshotEffect,
  loadSettingsSnapshotEffect,
  type SettingsEnv,
  type SettingsError,
} from "../_shared/settings";

export const NOTES_SETTINGS_KEY = "notes";

const AbsolutePathSchema = Schema.String.check(Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]).+/));

export const NotesSettingsSchema = Schema.Struct({
  provider: Schema.Literal("obsidian"),
  vaultPath: AbsolutePathSchema,
});

export type NotesSettings = typeof NotesSettingsSchema.Type;

export function loadNotesSettingsEffect(
  cwd = process.cwd(),
  env?: SettingsEnv,
): Effect.Effect<NotesSettings | null, SettingsError> {
  return Effect.flatMap(loadSettingsSnapshotEffect(cwd, env), (snapshot) => {
    const configured =
      NOTES_SETTINGS_KEY in snapshot.global || NOTES_SETTINGS_KEY in snapshot.project;
    if (!configured) return Effect.succeed(null);
    return decodeSettingsBlockFromSnapshotEffect(snapshot, NOTES_SETTINGS_KEY, NotesSettingsSchema);
  });
}
