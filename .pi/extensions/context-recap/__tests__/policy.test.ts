import { expect, it } from "vitest";
import { resolvePolicy, type CacheModel } from "../lifetime";

const codex: CacheModel = {
  id: "cache-model",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
};

it.each([
  ["anthropic", "anthropic-messages", "https://api.anthropic.com", true, undefined],
  ["openai", "openai-responses", "https://api.openai.com/v1", true, 300_000],
  ["openai", "openai-completions", "https://api.openai.com/v1", true, 300_000],
  [
    "openai-codex",
    "openai-codex-responses",
    "https://chatgpt.com/backend-api/codex",
    true,
    300_000,
  ],
  ["openai-codex", "openai-codex-responses", "https://chatgpt.com/other", false, undefined],
  ["openai", "openai-responses", "https://proxy.example", false, undefined],
  ["custom", "anthropic-messages", "https://api.anthropic.com", false, undefined],
  ["anthropic", "faux", "https://api.anthropic.com", false, undefined],
  ["openai", "openai-responses", "not a URL", false, undefined],
] as const)(
  "defaults require provider, transport and endpoint: %s %s %s",
  (provider, api, baseUrl, enabled, estimate) => {
    expect(resolvePolicy({ id: "cache-model", provider, api, baseUrl })).toMatchObject({
      enabled,
      estimate,
    });
  },
);

it.each([{ providerEnabled: false }, { enabled: false, providerEnabled: true }])(
  "honors persistent provider disablement and master off %#",
  (preferences) => {
    expect(resolvePolicy(codex, preferences).enabled).toBe(false);
  },
);

it("allows explicit opt-in and estimates for unknown providers", () => {
  expect(
    resolvePolicy(
      { ...codex, provider: "custom", baseUrl: "https://custom.example" },
      { providerEnabled: true, estimatedLifetimeMs: 60_000 },
    ),
  ).toMatchObject({
    enabled: true,
    estimate: 60_000,
    source: "configured estimate (not a cache guarantee)",
  });
});

it("gives configured estimates precedence over built-in estimates", () => {
  expect(resolvePolicy(codex, { estimatedLifetimeMs: 3_600_000 })).toMatchObject({
    estimate: 3_600_000,
    source: "configured estimate (not a cache guarantee)",
  });
});

it("blocks automatic recap while native idle warming owns the cache", () => {
  expect(resolvePolicy(codex).blocked).toBeUndefined();
  expect(resolvePolicy(codex, { idleWarming: true }).blocked).toBe(
    "native idle cache warming enabled",
  );
});
