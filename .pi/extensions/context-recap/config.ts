import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import {
  decodeSettingsBlockFromSnapshotEffect,
  loadSettingsSnapshotEffect,
  type SettingsEnv,
} from "../_shared/settings";
import { duration, modelKey } from "./lifetime";

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
export type Policy = {
  enabled: boolean;
  estimate?: number;
  source?: string;
  blocked?: string;
};
export type RuntimeOverride = { enabled: boolean; estimate?: { key: string; ttl: number } };

const providerDefaults = [
  { provider: "anthropic", apis: ["anthropic-messages"], origin: "https://api.anthropic.com" },
  {
    provider: "openai",
    apis: ["openai-responses", "openai-completions"],
    origin: "https://api.openai.com",
  },
  {
    provider: "openai-codex",
    apis: ["openai-codex-responses"],
    origin: "https://chatgpt.com",
    path: /^\/backend-api(?:\/|$)/,
  },
];

function builtin(model: ExtensionContext["model"]): Policy {
  if (!model) return { enabled: false };
  let endpoint: URL;
  try {
    endpoint = new URL(model.baseUrl);
  } catch {
    return { enabled: false };
  }
  const known = providerDefaults.some(
    (entry) =>
      entry.provider === model.provider &&
      entry.apis.includes(model.api) &&
      endpoint.origin === entry.origin &&
      (!entry.path || entry.path.test(endpoint.pathname)),
  );
  if (!known) return { enabled: false };
  // Anthropic needs actual request breakpoints. OpenAI/Codex's omitted TTL is
  // not an expiry promise; five minutes is our configurable scheduling policy.
  return model.provider === "anthropic"
    ? { enabled: true }
    : {
        enabled: true,
        estimate: 300_000,
        source: "built-in default estimate (not a cache guarantee)",
      };
}

function estimatePolicy(
  defaults: Policy,
  configured: string | undefined,
  override: RuntimeOverride["estimate"],
): Pick<Policy, "estimate" | "source"> {
  if (override)
    return { estimate: override.ttl, source: "runtime estimate (not a cache guarantee)" };
  if (configured)
    return {
      estimate: duration(configured),
      source: "configured estimate (not a cache guarantee)",
    };
  return { estimate: defaults.estimate, source: defaults.source };
}

export const loadPolicyEffect = Effect.fnUntraced(function* (
  cwd: string,
  model: ExtensionContext["model"],
  runtime?: RuntimeOverride,
  env?: SettingsEnv,
) {
  const snapshot = yield* loadSettingsSnapshotEffect(cwd, env);
  const warming = yield* Schema.decodeEffect(warmingSchema)(snapshot.global);
  const settings = yield* decodeSettingsBlockFromSnapshotEffect(
    snapshot,
    "contextRecap",
    settingsSchema,
  );
  const defaults = builtin(model);
  const provider = model ? settings.providers?.[model.provider] : undefined;
  const override = runtime?.estimate;
  const currentOverride = override?.key === modelKey({ model }) ? override : undefined;
  const policy: Policy = {
    enabled:
      settings.enabled !== false && (runtime?.enabled ?? provider?.enabled ?? defaults.enabled),
    ...estimatePolicy(defaults, provider?.estimatedLifetime, currentOverride),
  };
  if (warming.cacheWarming === "idle") policy.blocked = "native idle cache warming enabled";
  return policy;
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
