/**
 * providers.ts — Anthropic + Copilot usage fetchers for the usage-bar extension.
 *
 * Each fetcher accepts a pre-resolved API token (resolved by the caller via
 * ctx.modelRegistry.getApiKeyForProvider()). This ensures the extension uses
 * the same credentials as the active model — including OAuth-refreshed tokens,
 * env vars, and custom provider overrides.
 *
 * Fetchers return a FetchResult discriminated union so the caller can inspect
 * the HTTP status and retry-after header on rate-limit (429) responses.
 * Anthropic rate limits use a token bucket algorithm and always include a
 * `retry-after` header (seconds) on 429 responses.
 */

import type { AnthropicUsage, CopilotUsage } from "./types.js";

const FETCH_TIMEOUT_MS = 5_000;

// ─── Result type ──────────────────────────────────────────────────────────────

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; retryAfterSecs: number | undefined };

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the `retry-after` header (seconds) from a response, if present. */
function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? secs : undefined;
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

export async function fetchAnthropicUsage(token: string): Promise<FetchResult<AnthropicUsage>> {
  const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!res.ok) {
    return { ok: false, status: res.status, retryAfterSecs: parseRetryAfter(res) };
  }
  return { ok: true, data: (await res.json()) as AnthropicUsage };
}

// ─── Copilot ──────────────────────────────────────────────────────────────────

export async function fetchCopilotUsage(token: string): Promise<FetchResult<CopilotUsage>> {
  const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `token ${token}`,
      "Editor-Version": "vscode/1.96.2",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    return { ok: false, status: res.status, retryAfterSecs: parseRetryAfter(res) };
  }
  return { ok: true, data: (await res.json()) as CopilotUsage };
}
