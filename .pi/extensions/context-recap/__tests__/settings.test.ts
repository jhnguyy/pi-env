import { expect, it } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { loadPolicy } from "../config";
import type { SettingsEnv } from "../../_shared/settings";

function snapshot(global: unknown = {}, project: unknown = {}) {
  const reads: string[] = [];
  const env: SettingsEnv = {
    globalSettingsPath: () => "/isolated/global.json",
    projectSettingsPath: () => "/isolated/project.json",
    readFile: (path) => {
      reads.push(path);
      const document = path === "/isolated/global.json" ? global : project;
      if (document === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return typeof document === "string" ? document : JSON.stringify(document);
    },
  };
  return { env, reads };
}
const codex = () => ({
  ...fauxProvider().getModel(),
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
});

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
    const { env, reads } = snapshot();
    const model = { ...fauxProvider().getModel(), provider, api, baseUrl };
    expect(loadPolicy("/isolated", model, env)).toMatchObject({ enabled, estimate });
    expect(reads).toEqual(["/isolated/global.json", "/isolated/project.json"]);
  },
);

it("shallowly replaces the provider map before applying built-in defaults", () => {
  const model = codex();
  const { env } = snapshot(
    {
      contextRecap: { providers: { "openai-codex": { enabled: false, estimatedLifetime: "1h" } } },
    },
    { contextRecap: { providers: { custom: { enabled: true, estimatedLifetime: "1m" } } } },
  );
  expect(loadPolicy("/isolated", model, env)).toMatchObject({ enabled: true, estimate: 300_000 });
  model.provider = "custom";
  model.baseUrl = "https://custom.example";
  expect(loadPolicy("/isolated", model, env)).toMatchObject({
    enabled: true,
    estimate: 60_000,
    source: "configured estimate (not a cache guarantee)",
  });
});

it.each([
  { providers: { "openai-codex": { enabled: false } } },
  { enabled: false, providers: { "openai-codex": { enabled: true } } },
])("honors persistent provider disablement and master off %#", (contextRecap) => {
  const { env } = snapshot({ contextRecap });
  expect(loadPolicy("/isolated", codex(), env).enabled).toBe(false);
});

it("gives configured estimates precedence over built-in estimates", () => {
  const { env } = snapshot({
    contextRecap: { providers: { "openai-codex": { estimatedLifetime: "1h" } } },
  });
  expect(loadPolicy("/isolated", codex(), env)).toMatchObject({
    estimate: 3_600_000,
    source: "configured estimate (not a cache guarantee)",
  });
});

it("uses only global native warming ownership", () => {
  let f = snapshot({}, { cacheWarming: "idle" });
  expect(loadPolicy("/isolated", codex(), f.env).blocked).toBeUndefined();
  f = snapshot({ cacheWarming: "idle" }, { cacheWarming: "off" });
  expect(loadPolicy("/isolated", codex(), f.env).blocked).toBe("native idle cache warming enabled");
});

it.each([
  "SENSITIVE_SENTINEL",
  "[]",
  { cacheWarming: "SENSITIVE_SENTINEL" },
  { contextRecap: false },
  { contextRecap: { providers: { custom: { estimatedLifetime: "SENSITIVE_SENTINEL" } } } },
  { contextRecap: { enabled: "SENSITIVE_SENTINEL" } },
])("suppresses automatic recap on invalid settings %# without raw values", (value) => {
  const f = snapshot(value);
  const policy = loadPolicy("/isolated", codex(), f.env);
  expect(policy.enabled).toBe(false);
  expect(policy.blocked).toContain("repair contextRecap/cacheWarming in settings.json");
  expect(policy.blocked).not.toContain("SENSITIVE_SENTINEL");
});
