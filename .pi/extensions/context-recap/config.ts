import { Effect, Schema } from "effect";
import {
  decodeSettingsBlockFromSnapshotEffect,
  loadSettingsSnapshotEffect,
  type SettingsEnv,
} from "../_shared/settings";
import { duration, resolvePolicy, type CacheModel, type Policy } from "./lifetime";

const providerSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  estimatedLifetime: Schema.optionalKey(
    Schema.String.check(Schema.makeFilter((text) => duration(text) !== undefined)),
  ),
});
export const settingsSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  providers: Schema.optionalKey(Schema.Record(Schema.String, providerSchema)),
});
const warmingSchema = Schema.Struct({
  cacheWarming: Schema.optionalKey(Schema.Literals(["off", "streaming", "idle"])),
});
export const loadPolicyEffect = Effect.fnUntraced(function* (
  cwd: string,
  model: CacheModel | undefined,
  env?: SettingsEnv,
) {
  const snapshot = yield* loadSettingsSnapshotEffect(cwd, env);
  const warming = yield* Schema.decodeEffect(warmingSchema)(snapshot.global);
  const settings = yield* decodeSettingsBlockFromSnapshotEffect(
    snapshot,
    "contextRecap",
    settingsSchema,
  );
  const provider = model ? settings.providers?.[model.provider] : undefined;
  return resolvePolicy(model, {
    enabled: settings.enabled,
    providerEnabled: provider?.enabled,
    estimatedLifetimeMs: provider?.estimatedLifetime
      ? duration(provider.estimatedLifetime)
      : undefined,
    idleWarming: warming.cacheWarming === "idle",
  });
});

export function loadPolicy(...args: Parameters<typeof loadPolicyEffect>): Policy {
  return Effect.runSync(
    loadPolicyEffect(...args).pipe(
      Effect.orElseSucceed(
        (): Policy => ({
          enabled: false,
          blocked:
            "settings uncertain; repair contextRecap/cacheWarming in settings.json before automatic recap",
        }),
      ),
    ),
  );
}
