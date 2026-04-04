import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { fetchAnthropicUsage, fetchCopilotUsage, type FetchResult } from "../providers";
import type { AnthropicUsage, CopilotUsage } from "../types";

// ─── fetch mock helpers ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): void {
  globalThis.fetch = (async () =>
    ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      headers: new Headers(response.headers ?? {}),
      json: async () => response.body ?? {},
    }) as Response) as unknown as typeof fetch;
}

function mockFetchThrow(error: Error): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as unknown as typeof fetch;
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

  it("returns ok:false on non-ok response", async () => {
    mockFetch({ ok: false, status: 500 });
    const result = await fetchAnthropicUsage("token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.retryAfterSecs).toBeUndefined();
    }
  });

  it("returns ok:false with retryAfterSecs on 429", async () => {
    mockFetch({ ok: false, status: 429, headers: { "retry-after": "30" } });
    const result = await fetchAnthropicUsage("token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.retryAfterSecs).toBe(30);
    }
  });

  it("returns parsed usage on ok response", async () => {
    mockFetch({ ok: true, body: validUsage });
    const result = await fetchAnthropicUsage("token");
    expect(result).toEqual({ ok: true, data: validUsage });
  });

  it("propagates fetch errors (e.g. timeout)", async () => {
    mockFetchThrow(new Error("AbortError"));
    await expect(fetchAnthropicUsage("token")).rejects.toThrow("AbortError");
  });

  it("sends Authorization header with Bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit | BunFetchRequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      return { ok: true, status: 200, headers: new Headers(), json: async () => validUsage } as Response;
    }) as unknown as typeof fetch;
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

  it("returns ok:false on non-ok response", async () => {
    mockFetch({ ok: false, status: 403 });
    const result = await fetchCopilotUsage("token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.retryAfterSecs).toBeUndefined();
    }
  });

  it("returns ok:false with retryAfterSecs on 429", async () => {
    mockFetch({ ok: false, status: 429, headers: { "retry-after": "15" } });
    const result = await fetchCopilotUsage("token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.retryAfterSecs).toBe(15);
    }
  });

  it("returns parsed usage on ok response", async () => {
    mockFetch({ ok: true, body: validUsage });
    const result = await fetchCopilotUsage("token");
    expect(result).toEqual({ ok: true, data: validUsage });
  });

  it("propagates fetch errors (e.g. timeout)", async () => {
    mockFetchThrow(new Error("AbortError"));
    await expect(fetchCopilotUsage("token")).rejects.toThrow("AbortError");
  });

  it("sends Authorization header with token prefix", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit | BunFetchRequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      return { ok: true, status: 200, headers: new Headers(), json: async () => validUsage } as Response;
    }) as unknown as typeof fetch;
    await fetchCopilotUsage("ghu_test");
    expect(capturedHeaders["Authorization"]).toBe("token ghu_test");
  });
});
