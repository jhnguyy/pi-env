/**
 * usage-bar — pi extension entry point.
 *
 * Shows API usage quotas for Anthropic and Copilot in the pi status line.
 * Auto-detects the active provider from ctx.model?.provider and fetches only
 * that provider's usage. Refreshes on session_start and model_select.
 *
 * Subagent detection: uses isHeadless(ctx) from _shared/context — false in
 * non-interactive (RPC/print) mode. See _shared/context.ts for rationale on
 * why PI_AGENT_ID is not used.
 *
 * Credentials: Anthropic uses ctx.modelRegistry.getApiKeyForProvider(). For
 * github-copilot, credentials.refresh (the GitHub OAuth token) is used instead
 * of credentials.access (the short-lived Copilot API token) because the usage
 * endpoint (api.github.com) requires the GitHub token, not the Copilot token.
 * Error handling: silent on missing credentials; brief "fetch failed" on errors.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AnthropicUsage, CopilotUsage } from "./types.js";
import { fetchAnthropicUsage, fetchCopilotUsage, type FetchResult } from "./providers.js";
import { isHeadless } from "../_shared/context.js";
import { setSlot, clearSlot } from "../_shared/ui-render.js";

// ─── Progress bar ─────────────────────────────────────────────────────────────

/** Build a 5-cell progress bar: e.g. ▐███░░▌ */
function progressBar(pct: number): string {
  const total = 5;
  const filled = Math.round((pct / 100) * total);
  const bar = "█".repeat(filled) + "░".repeat(total - filled);
  return `▐${bar}▌`;
}

/** Color text based on utilization percentage using theme semantic colors. */
function colorByPct(theme: Theme, pct: number, text: string): string {
  if (pct >= 80) return theme.fg("error", text);
  if (pct >= 50) return theme.fg("warning", text);
  return theme.fg("success", text);
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

/** Format ISO8601 reset time as a compact countdown from now.
 *  < 1 min → "soon" | < 1 h → "42m" | < 24 h → "5h 30m" | ≥ 24 h → "4d 3h"
 */
function formatResetIn(isoDate: string): string {
  const resets = new Date(isoDate).getTime();
  const now = Date.now();
  const diffMs = resets - now;
  if (diffMs <= 0) return "now";
  const totalMins = Math.round(diffMs / 60_000);
  if (totalMins < 1) return "soon";
  if (totalMins < 60) return `${totalMins}m`;
  const totalHours = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (totalHours < 24) return m > 0 ? `${totalHours}h ${m}m` : `${totalHours}h`;
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Format a UTC date string (YYYY-MM-DD) as "Apr 1". */
function formatShortDate(utcDate: string): string {
  const d = new Date(utcDate + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatAnthropicStatus(theme: Theme, usage: AnthropicUsage): string {
  const fiveHrPct = usage.five_hour.utilization;
  const weekPct = usage.seven_day.utilization;

  // Progress bar tracks whichever window is more constrained.
  const barPct = Math.max(fiveHrPct, weekPct);

  const bar = colorByPct(theme, barPct, progressBar(barPct));
  const fiveHrStr = colorByPct(theme, fiveHrPct, `${fiveHrPct}%`);
  const weekStr = colorByPct(theme, weekPct, `${weekPct}%`);
  // Each window shows its own reset time inline via the ↻ icon.
  const fiveHrReset = theme.fg("muted", `↻${formatResetIn(usage.five_hour.resets_at)}`);
  const weekReset = theme.fg("muted", `↻${formatResetIn(usage.seven_day.resets_at)}`);

  const label = theme.fg("customMessageLabel", "\x1b[1m[usage]\x1b[22m");
  return `${label} Claude ${bar} 5h: ${fiveHrStr} ${fiveHrReset} · Week: ${weekStr} ${weekReset}`;
}

function formatCopilotStatus(theme: Theme, usage: CopilotUsage): string {
  const snap = usage.quota_snapshots?.premium_interactions;
  if (!snap) return `Copilot ${theme.fg("muted", "no quota data")}`;

  const pctUsed = 100 - snap.percent_remaining;
  const bar = colorByPct(theme, pctUsed, progressBar(pctUsed));
  const pctStr = colorByPct(theme, pctUsed, `${Math.round(pctUsed)}%`);
  const reqStr = theme.fg("muted", `${snap.remaining}/${snap.entitlement} reqs`);
  const resetStr = theme.fg("muted", `↻${formatShortDate(usage.quota_reset_date_utc)}`);

  const label = theme.fg("customMessageLabel", "\x1b[1m[usage]\x1b[22m");
  return `${label} Copilot ${bar} Month: ${pctStr} · ${reqStr} · ${resetStr}`;
}

// ─── Provider → usage API mapping ─────────────────────────────────────────────

const PROVIDER_FETCHERS: Record<string, (token: string) => Promise<FetchResult<unknown>>> = {
  anthropic: fetchAnthropicUsage,
  "github-copilot": fetchCopilotUsage,
};

const PROVIDER_FORMATTERS: Record<string, (theme: Theme, usage: any) => string> = {
  anthropic: formatAnthropicStatus,
  "github-copilot": formatCopilotStatus,
};

// ─── Refresh state ────────────────────────────────────────────────────────────

/**
 * Minimum ms between automatic (turn_end) refreshes. Usage numbers change
 * every turn, but the usage API has its own rate limits — 60s is a reasonable
 * floor that keeps numbers fresh without tripping token-bucket limits.
 */
const MIN_REFRESH_INTERVAL_MS = 60_000; // 1 minute

/** Timestamp (ms) of the last successful fetch. */
let lastRefreshMs = 0;

/**
 * Hard floor: earliest time (ms) we're allowed to call the usage API.
 * Set from the `retry-after` header on 429 responses. Even forced refreshes
 * (session_start, model_select) respect this — the server said "not yet."
 */
let retryAfterDeadlineMs = 0;

// ─── Refresh ──────────────────────────────────────────────────────────────────

/**
 * Refresh the usage bar.
 * @param force — bypass the MIN_REFRESH_INTERVAL (session_start, model_select).
 *                Does NOT bypass retry-after deadlines from 429s.
 */
async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
  const now = Date.now();

  // Always respect server-imposed retry-after deadline, even for forced refreshes.
  if (now < retryAfterDeadlineMs) return;

  // Non-forced (turn_end) refreshes respect the minimum interval.
  if (!force && now - lastRefreshMs < MIN_REFRESH_INTERVAL_MS) return;

  const provider = ctx.model?.provider;
  if (!provider || !(provider in PROVIDER_FETCHERS)) {
    clearSlot("usage-bar", ctx);
    return;
  }

  try {
    // Resolve token for usage API.
    // github-copilot: the usage endpoint (api.github.com/copilot_internal/user)
    // requires the GitHub OAuth token — stored in credentials.refresh.
    // getApiKeyForProvider() returns credentials.access (the short-lived Copilot
    // API token for *.githubcopilot.com), which is wrong for this endpoint.
    let token: string | undefined;
    if (provider === "github-copilot") {
      const cred = ctx.modelRegistry.authStorage.get("github-copilot");
      token = cred?.type === "oauth" ? (cred as any).refresh : undefined;
    } else {
      token = await ctx.modelRegistry.getApiKeyForProvider(provider);
    }
    if (!token) { clearSlot("usage-bar", ctx); return; }

    const result = await PROVIDER_FETCHERS[provider](token);

    if (result.ok) {
      lastRefreshMs = now;
      setSlot("usage-bar", PROVIDER_FORMATTERS[provider](ctx.ui.theme, result.data), ctx);
      return;
    }

    // ── Non-OK response ──────────────────────────────────────────────────────
    if (result.status === 429 && result.retryAfterSecs) {
      // Server told us exactly when to retry — honour it.
      retryAfterDeadlineMs = now + result.retryAfterSecs * 1_000;
    } else if (result.status === 429) {
      // 429 without retry-after: back off 60s as a safe default.
      retryAfterDeadlineMs = now + 60_000;
    }
    // Keep stale data visible — don't clearSlot on transient failures.
  } catch {
    // Network error / timeout: keep stale data visible, don't blank the bar.
  }
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (isHeadless(ctx)) return;

    if (ctx.model) {
      await refresh(ctx, true);
    } else {
      // ctx.model may be undefined at session_start if the model restore event
      // fired before extensions were loaded. Retry once after a short delay.
      setTimeout(async () => {
        if (ctx.model) await refresh(ctx, true);
      }, 500);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    if (isHeadless(ctx)) return;
    await refresh(ctx, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (isHeadless(ctx)) return;
    await refresh(ctx); // respects REFRESH_COOLDOWN_MS
  });
}
