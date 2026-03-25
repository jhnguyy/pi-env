/**
 * types.ts — shared types for the usage-bar extension.
 */

/** A single usage window returned by the Anthropic OAuth usage endpoint. */
interface AnthropicWindow {
  utilization: number;
  resets_at: string;
}

export interface AnthropicUsage {
  five_hour: AnthropicWindow;
  seven_day: AnthropicWindow;
  /** Per-model weekly windows — null when not applicable to the active plan. */
  seven_day_oauth_apps?: AnthropicWindow | null;
  seven_day_opus?: AnthropicWindow | null;
  seven_day_sonnet?: AnthropicWindow | null;
  seven_day_cowork?: AnthropicWindow | null;
  /** Internal Anthropic field — nullable, treated as opaque. */
  iguana_necktie?: AnthropicWindow | null;
  extra_usage?: {
    is_enabled: boolean;
    used_credits: number | null;
    monthly_limit: number | null;
    utilization: number | null;
  };
}

export interface CopilotUsage {
  quota_reset_date_utc: string;
  quota_snapshots: {
    premium_interactions: {
      percent_remaining: number;
      remaining: number;
      entitlement: number;
    };
  };
}
