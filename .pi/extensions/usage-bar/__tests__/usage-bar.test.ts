import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { fetchAnthropicUsage, fetchCopilotUsage } from "../providers";
import type { AnthropicUsage, CopilotUsage } from "../types";

// ─── fetch mock helpers ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(response: { ok: boolean; body?: unknown }): void {
  globalThis.fetch = async () =>
    ({
      ok: response.ok,
      json: async () => response.body ?? {},
    }) as Response;
}

function mockFetchThrow(error: Error): void {
  globalThis.fetch = async () => {
    throw error;
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describeIfEnabled("usage-bar", "fetchAnthropicUsage", () => {
  const validUsage: AnthropicUsage = {
    five_hour: { utilization: 42, resets_at: "2026-03-24T20:00:00Z" },
    seven_day: { utilization: 15, resets_at: "2026-03-28T00:00:00Z" },
  };

  it("returns null on non-ok response", async () => {
    mockFetch({ ok: false });
    const result = await fetchAnthropicUsage("token");
    expect(result).toBeNull();
  });

  it("returns parsed usage on ok response", async () => {
    mockFetch({ ok: true, body: validUsage });
    const result = await fetchAnthropicUsage("token");
    expect(result).toEqual(validUsage);
  });

  it("propagates fetch errors (e.g. timeout)", async () => {
    mockFetchThrow(new Error("AbortError"));
    await expect(fetchAnthropicUsage("token")).rejects.toThrow("AbortError");
  });

  it("sends Authorization header with Bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = async (_url, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      return { ok: true, json: async () => validUsage } as Response;
    };
    await fetchAnthropicUsage("sk-ant-test");
    expect(capturedHeaders["Authorization"]).toBe("Bearer sk-ant-test");
  });
});

describeIfEnabled("usage-bar", "fetchCopilotUsage", () => {
  const validUsage: CopilotUsage = {
    quota_reset_date_utc: "2026-04-01",
    quota_snapshots: {
      premium_interactions: {
        percent_remaining: 75,
        remaining: 750,
        entitlement: 1000,
      },
    },
  };

  it("returns null on non-ok response", async () => {
    mockFetch({ ok: false });
    const result = await fetchCopilotUsage("token");
    expect(result).toBeNull();
  });

  it("returns parsed usage on ok response", async () => {
    mockFetch({ ok: true, body: validUsage });
    const result = await fetchCopilotUsage("token");
    expect(result).toEqual(validUsage);
  });

  it("propagates fetch errors (e.g. timeout)", async () => {
    mockFetchThrow(new Error("AbortError"));
    await expect(fetchCopilotUsage("token")).rejects.toThrow("AbortError");
  });

  it("sends Authorization header with token prefix", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = async (_url, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      return { ok: true, json: async () => validUsage } as Response;
    };
    await fetchCopilotUsage("ghu_test");
    expect(capturedHeaders["Authorization"]).toBe("token ghu_test");
  });
});
