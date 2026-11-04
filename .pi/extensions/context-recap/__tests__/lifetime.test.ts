import { expect, it } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { duration, requestLifetime } from "../lifetime";

const model = (api: string, extra = {}) => ({
  ...fauxProvider().getModel(),
  api,
  baseUrl: "https://api.openai.com/v1",
  ...extra,
});

it("reads only actual Anthropic cache envelopes, choosing the shortest known breakpoint", () => {
  const m = model("anthropic-messages");
  const nested = { cache_control: { type: "ephemeral", ttl: "invalid" } };
  expect(
    requestLifetime(
      {
        system: [
          { cache_control: { type: "ephemeral", ttl: "1h" } },
          { cache_control: { type: "ephemeral" } },
        ],
      },
      m,
    ),
  ).toBe(300_000);
  for (const envelope of [
    { cache_control: { type: "ephemeral", ttl: "1h" } },
    { tools: [{ cache_control: { type: "ephemeral", ttl: "1h" }, input_schema: nested }] },
    {
      messages: [{ content: [{ cache_control: { type: "ephemeral", ttl: "1h" }, input: nested }] }],
    },
  ])
    expect(requestLifetime(envelope, m)).toBe(3_600_000);
  expect(
    requestLifetime(
      {
        tools: [{ input_schema: nested }],
        messages: [{ content: [{ input: nested, text: JSON.stringify(nested) }] }],
      },
      m,
    ),
  ).toBe("off");
  expect(requestLifetime({ cache_control: { type: "ephemeral", ttl: "2h" } }, m)).toBeUndefined();
  expect(requestLifetime({}, m)).toBe("off");
});

it("reads modern public OpenAI metadata without mistaking nested data for breakpoints", () => {
  const m = model("openai-responses", { compat: { supportsExplicitPromptCacheMode: true } });
  expect(requestLifetime({}, m)).toBe(1_800_000);
  expect(requestLifetime({ prompt_cache_options: { ttl: "30m" } }, m)).toBe(1_800_000);
  expect(requestLifetime({ prompt_cache_options: { ttl: "12h" } }, m)).toBe(43_200_000);
  expect(requestLifetime({ prompt_cache_options: { mode: "explicit" } }, m)).toBe("off");
  expect(requestLifetime({ prompt_cache_options: { ttl: "24h" } }, m)).toBeUndefined();
  for (const mode of ["explicit", "implicit"]) {
    expect(
      requestLifetime(
        {
          prompt_cache_options: { mode, ttl: "12h" },
          input: [{ content: [{ prompt_cache_breakpoint: { ttl: "30m" } }] }],
        },
        m,
      ),
    ).toBe(1_800_000);
  }
  expect(
    requestLifetime(
      {
        prompt_cache_options: { mode: "explicit", ttl: "12h" },
        input: [
          {
            content: [
              {
                prompt_cache_breakpoint: {},
                sample: { prompt_cache_breakpoint: { ttl: "unknown" } },
              },
            ],
          },
        ],
      },
      m,
    ),
  ).toBe(43_200_000);
  expect(
    requestLifetime(
      {
        prompt_cache_options: { mode: "explicit" },
        tools: [{ parameters: { prompt_cache_breakpoint: {} } }],
        input: [
          {
            content: [
              { text: '{"prompt_cache_breakpoint":{}}', sample: { prompt_cache_breakpoint: {} } },
            ],
          },
        ],
      },
      m,
    ),
  ).toBe("off");
  expect(requestLifetime({ model: "different-physical-model" }, m)).toBe("ineligible");
});

it("uses explicit Codex metadata but never invents its omitted TTL", () => {
  const m = model("openai-codex-responses", { baseUrl: "https://chatgpt.com/backend-api" });
  expect(requestLifetime({}, m)).toBeUndefined();
  expect(requestLifetime({ prompt_cache_options: { mode: "implicit" } }, m)).toBeUndefined();
  expect(requestLifetime({ prompt_cache_options: { ttl: "30m" } }, m)).toBe(1_800_000);
  expect(requestLifetime({ prompt_cache_options: { ttl: "12h" } }, m)).toBe(43_200_000);
  expect(requestLifetime({ prompt_cache_options: { mode: "explicit" } }, m)).toBe("off");
});

it("does not infer metadata deadlines from legacy retention, Codex, proxies or model tiers", () => {
  for (const m of [
    model("openai-responses"),
    model("openai-codex-responses"),
    model("openai-responses", {
      baseUrl: "https://proxy.example",
      compat: { supportsExplicitPromptCacheMode: true },
    }),
    model("faux", { promptCache: { short: 300, long: 3600 } }),
  ])
    expect(requestLifetime({ prompt_cache_retention: "24h" }, m)).toBeUndefined();
});

it("requires a scheduling window longer than the minimum launch margin", () => {
  expect(duration("1m")).toBe(60_000);
  expect(duration("12h")).toBe(43_200_000);
  for (const text of ["0s", "1s", "0.5m", "-1m", "5", "Infinityh", "999999999h"])
    expect(duration(text)).toBeUndefined();
});
