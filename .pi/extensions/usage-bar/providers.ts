/**
 * providers.ts — Anthropic + Copilot usage fetchers for the usage-bar extension.
 *
 * Reads credentials from ~/.pi/agent/auth.json (same format pi uses).
 * Uses native fetch with a 5-second timeout. No external dependencies.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { AnthropicUsage, AuthJson, CopilotUsage } from "./types.js";

/** Resolve the agent directory — respects PI_CODING_AGENT_DIR if set. */
function agentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
  return join(homedir(), ".pi", "agent");
}

const FETCH_TIMEOUT_MS = 5_000;

// ─── Auth ────────────────────────────────────────────────────────────────────

function readAuth(): AuthJson | null {
  try {
    const raw = readFileSync(join(agentDir(), "auth.json"), "utf-8");
    return JSON.parse(raw) as AuthJson;
  } catch {
    return null;
  }
}

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

export async function fetchAnthropicUsage(): Promise<AnthropicUsage | null> {
  const auth = readAuth();
  const token = auth?.anthropic?.access;
  if (!token) return null;

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

export async function fetchCopilotUsage(): Promise<CopilotUsage | null> {
  const auth = readAuth();
  // Prefer refresh token (GitHub PAT) for GitHub API endpoints
  const token = auth?.["github-copilot"]?.refresh ?? auth?.["github-copilot"]?.access;
  if (!token) return null;

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
