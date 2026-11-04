import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { isObject, loadSettingsSnapshotEffect } from "../_shared/settings";

const warmingSchema = Schema.Struct({
  cacheWarming: Schema.optional(Schema.Literals(["off", "streaming", "idle"])),
});
const decodeWarming = Schema.decodeUnknownEffect(warmingSchema);

export function warmingBlock(cwd: string): string | undefined {
  return Effect.runSync(
    loadSettingsSnapshotEffect(cwd).pipe(
      Effect.flatMap((snapshot) => decodeWarming(snapshot.global)),
      Effect.map((settings) =>
        settings.cacheWarming === "idle" ? "native idle cache warming enabled" : undefined,
      ),
      Effect.orElseSucceed(
        () => "settings uncertain; repair settings.json before enabling automatic recap",
      ),
    ),
  );
}

export function modelKey(ctx: Pick<ExtensionContext, "model">): string {
  const m = ctx.model;
  return m ? JSON.stringify([m.provider, m.id, m.api, m.baseUrl]) : "";
}

type Lifetime = number | "off" | undefined;

/** Only provider envelope positions participate, never arbitrary user/schema data. */
function shortestBreakpoint(
  envelopes: unknown[],
  field: string,
  parse: (value: unknown) => number | undefined,
): Lifetime {
  let shortest = Infinity;
  let unknown = false;
  for (const value of envelopes) {
    if (!isObject(value) || value[field] === undefined) continue;
    const ttl = parse(value[field]);
    if (ttl) shortest = Math.min(shortest, ttl);
    else unknown = true;
  }
  if (unknown) return;
  return shortest === Infinity ? "off" : shortest;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function contentBlocks(items: unknown): unknown[] {
  return array(items).flatMap((item) => (isObject(item) ? array(item.content) : []));
}

function anthropicLifetime(payload: Record<string, unknown>): Lifetime {
  const envelopes = [
    payload,
    ...array(payload.system),
    ...array(payload.tools),
    ...contentBlocks(payload.messages),
  ];
  return shortestBreakpoint(envelopes, "cache_control", (control) => {
    if (!isObject(control) || control.type !== "ephemeral") return;
    if (control.ttl === undefined || control.ttl === "5m") return 300_000;
    if (control.ttl === "1h") return 3_600_000;
    return;
  });
}

function openAITtl(ttl: unknown): number | undefined {
  if (ttl === undefined || ttl === "30m") return 1_800_000;
  if (ttl === "12h") return 43_200_000;
  return;
}

function openAILifetime(payload: Record<string, unknown>): Lifetime {
  const options = payload.prompt_cache_options;
  if (options !== undefined && !isObject(options)) return;
  const settings = isObject(options) ? options : {};
  const defaultTtl = openAITtl(settings.ttl);
  if (!defaultTtl) return;
  const shortest = shortestBreakpoint(
    contentBlocks(payload.input),
    "prompt_cache_breakpoint",
    (bp) => {
      if (!isObject(bp)) return;
      return bp.ttl === undefined ? defaultTtl : openAITtl(bp.ttl);
    },
  );
  if (shortest === undefined) return;
  if (settings.mode === "explicit") return shortest;
  if (settings.mode !== undefined && settings.mode !== "implicit") return;
  return shortest === "off" ? defaultTtl : Math.min(defaultTtl, shortest);
}

/** Only facts leave the provider hook; never retain the request or credentials. */
export function requestLifetime(payload: unknown, model: ExtensionContext["model"]): Lifetime {
  if (!model || !isObject(payload)) return;
  // Selected-model compatibility is not evidence about a different outgoing model.
  if (payload.model !== undefined && payload.model !== model.id) return;
  if (model.api === "anthropic-messages") return anthropicLifetime(payload);
  let publicOpenAI = false;
  try {
    publicOpenAI = new URL(model.baseUrl).origin === "https://api.openai.com";
  } catch {
    return;
  }
  if (model.api !== "openai-responses" || !publicOpenAI) return;
  if (
    model.compat &&
    "supportsExplicitPromptCacheMode" in model.compat &&
    model.compat.supportsExplicitPromptCacheMode
  )
    return openAILifetime(payload);
  // Legacy 24h is an upper retention bound, not a fixed expiry deadline.
  return;
}

export function duration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(text);
  if (!match) return;
  const value = Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[match[2]] ?? 0);
  return Number.isSafeInteger(value) && value > 30_000 && value <= 2_147_483_647
    ? value
    : undefined;
}
