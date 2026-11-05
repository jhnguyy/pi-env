import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import {
  decodeSettingsBlockFromSnapshotEffect,
  loadSettingsSnapshotEffect,
  type SettingsEnv,
} from "../_shared/settings";
import { duration } from "./lifetime";

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

export const loadPolicyEffect = Effect.fnUntraced(function* (
  cwd: string,
  model: ExtensionContext["model"],
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
  const configured = provider?.estimatedLifetime;
  const policy: Policy = {
    enabled: settings.enabled !== false && (provider?.enabled ?? defaults.enabled),
    estimate: configured ? duration(configured) : defaults.estimate,
    source: configured ? "configured estimate (not a cache guarantee)" : defaults.source,
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
