/**
 * types.ts — shared types for the usage-bar extension.
 */

export interface AnthropicUsage {
  five_hour: {
    utilization: number;
    resets_at: string;
  };
  seven_day: {
    utilization: number;
    resets_at: string;
  };
  extra_usage?: {
    is_enabled: boolean;
    used_credits: number;
    monthly_limit: number;
    utilization: number;
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
