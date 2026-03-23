/**
 * usage-bar — pi extension entry point.
 *
 * Shows API usage quotas for Anthropic and Copilot in the pi status line.
 * Auto-detects the active provider from ctx.model?.provider and fetches only
 * that provider's usage. Refreshes on session_start and model_select.
 *
 * Subagent detection: if PI_AGENT_ID is set, rendering is skipped entirely
 * (subagents don't need usage display).
 *
 * Credentials: read from ~/.pi/agent/auth.json (same format pi uses).
 * Error handling: silent on missing credentials; brief "fetch failed" on errors.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AnthropicUsage, CopilotUsage } from "./types.js";
import { fetchAnthropicUsage, fetchCopilotUsage } from "./providers.js";

const STATUS_KEY = "usage-bar";

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

/** Format ISO8601 reset time as "Xh Ym" from now, or "soon" if < 1 min. */
function formatResetIn(isoDate: string): string {
  const resets = new Date(isoDate).getTime();
  const now = Date.now();
  const diffMs = resets - now;
  if (diffMs <= 0) return "now";
  const totalMins = Math.round(diffMs / 60_000);
  if (totalMins < 1) return "soon";
  if (totalMins < 60) return `${totalMins}m`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
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

  // Use the higher of the two for the progress bar and reset time
  const dominant = fiveHrPct >= weekPct ? usage.five_hour : usage.seven_day;
  const barPct = dominant.utilization;

  const bar = colorByPct(theme, barPct, progressBar(barPct));
  const fiveHrStr = colorByPct(theme, fiveHrPct, `${fiveHrPct}%`);
  const weekStr = colorByPct(theme, weekPct, `${weekPct}%`);
  const resetStr = theme.fg("muted", `Resets ${formatResetIn(dominant.resets_at)}`);

  return `Claude ${bar} 5h: ${fiveHrStr} · Week: ${weekStr} · ${resetStr}`;
}

function formatCopilotStatus(theme: Theme, usage: CopilotUsage): string {
  const snap = usage.quota_snapshots?.premium_interactions;
  if (!snap) return `Copilot ${theme.fg("muted", "no quota data")}`;

  const pctUsed = 100 - snap.percent_remaining;
  const bar = colorByPct(theme, pctUsed, progressBar(pctUsed));
  const pctStr = colorByPct(theme, pctUsed, `${Math.round(pctUsed)}%`);
  const reqStr = theme.fg("muted", `${snap.remaining}/${snap.entitlement} reqs`);
  const resetStr = theme.fg("muted", `Resets ${formatShortDate(usage.quota_reset_date_utc)}`);

  return `Copilot ${bar} Month: ${pctStr} · ${reqStr} · ${resetStr}`;
}

// ─── Provider → usage API mapping ─────────────────────────────────────────────

const PROVIDER_FETCHERS: Record<string, (token: string) => Promise<unknown>> = {
  anthropic: fetchAnthropicUsage,
  "github-copilot": fetchCopilotUsage,
};

const PROVIDER_FORMATTERS: Record<string, (theme: Theme, usage: any) => string> = {
  anthropic: formatAnthropicStatus,
  "github-copilot": formatCopilotStatus,
};

// ─── Refresh ──────────────────────────────────────────────────────────────────

async function refresh(ctx: ExtensionContext): Promise<void> {
  const provider = ctx.model?.provider;
  if (!provider || !(provider in PROVIDER_FETCHERS)) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  try {
    // Resolve token through pi's auth pipeline — same credentials as the active model
    const token = await ctx.modelRegistry.getApiKeyForProvider(provider);
    if (!token) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const usage = await PROVIDER_FETCHERS[provider](token);
    if (!usage) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, PROVIDER_FORMATTERS[provider](ctx.ui.theme, usage));
  } catch {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "Usage: fetch failed"));
    setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 4_000);
  }
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_AGENT_ID) return;
    if (!ctx.hasUI) return;

    if (ctx.model) {
      await refresh(ctx);
    } else {
      // model_select with source="restore" fires before extensions load;
      // ctx.model may be undefined at session_start. Retry once after a tick.
      setTimeout(async () => {
        if (ctx.model) await refresh(ctx);
      }, 500);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    if (process.env.PI_AGENT_ID) return;
    if (!ctx.hasUI) return;
    await refresh(ctx);
  });
}
