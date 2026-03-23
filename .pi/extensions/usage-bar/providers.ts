/**
 * providers.ts — Anthropic + Copilot usage fetchers for the usage-bar extension.
 *
 * Each fetcher accepts a pre-resolved API token (resolved by the caller via
 * ctx.modelRegistry.getApiKeyForProvider()). This ensures the extension uses
 * the same credentials as the active model — including OAuth-refreshed tokens,
 * env vars, and custom provider overrides.
 */

import type { AnthropicUsage, CopilotUsage } from "./types.js";

const FETCH_TIMEOUT_MS = 5_000;

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

// ─── Anthropic ────────────────────────────────────────────────────────────────

export async function fetchAnthropicUsage(token: string): Promise<AnthropicUsage | null> {
  const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!res.ok) return null;
  return (await res.json()) as AnthropicUsage;
}

// ─── Copilot ──────────────────────────────────────────────────────────────────

export async function fetchCopilotUsage(token: string): Promise<CopilotUsage | null> {
  const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `token ${token}`,
      "Editor-Version": "vscode/1.96.2",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
      Accept: "application/json",
    },
  });

  if (!res.ok) return null;
  return (await res.json()) as CopilotUsage;
}
