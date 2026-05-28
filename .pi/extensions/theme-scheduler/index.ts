import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSettingsBlock, type SettingsBlock } from "../_shared/settings";

export interface ThemeSchedulerConfig {
  enabled: boolean;
  lightTheme: string;
  darkTheme: string;
  lightStart: string;
  lightEnd: string;
  pollIntervalMs: number;
}

const DEFAULT_CONFIG: ThemeSchedulerConfig = {
  enabled: false,
  lightTheme: "gruvbox-light",
  darkTheme: "gruvbox-dark",
  lightStart: "10:00",
  lightEnd: "16:00",
  pollIntervalMs: 60_000,
};

function mergeConfig(base: ThemeSchedulerConfig, raw: SettingsBlock | null): ThemeSchedulerConfig {
  if (!raw) return base;

  const pollIntervalMs = typeof raw.pollIntervalMs === "number" && Number.isFinite(raw.pollIntervalMs)
    ? Math.max(raw.pollIntervalMs, 1_000)
    : base.pollIntervalMs;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    lightTheme: typeof raw.lightTheme === "string" && raw.lightTheme.trim() ? raw.lightTheme : base.lightTheme,
    darkTheme: typeof raw.darkTheme === "string" && raw.darkTheme.trim() ? raw.darkTheme : base.darkTheme,
    lightStart: typeof raw.lightStart === "string" && raw.lightStart.trim() ? raw.lightStart : base.lightStart,
    lightEnd: typeof raw.lightEnd === "string" && raw.lightEnd.trim() ? raw.lightEnd : base.lightEnd,
    pollIntervalMs,
  };
}

export function loadConfig(cwd: string): ThemeSchedulerConfig {
  return mergeConfig(DEFAULT_CONFIG, readSettingsBlock("themeScheduler", cwd));
}

export function parseTimeOfDay(value: string): number | null {
  const trimmed = value.trim();
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(trimmed);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return hours * 60 + minutes;
}

export function isWithinWindow(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function selectTheme(config: ThemeSchedulerConfig, now = new Date()): string {
  const startMinutes = parseTimeOfDay(config.lightStart) ?? parseTimeOfDay(DEFAULT_CONFIG.lightStart)!;
  const endMinutes = parseTimeOfDay(config.lightEnd) ?? parseTimeOfDay(DEFAULT_CONFIG.lightEnd)!;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return isWithinWindow(nowMinutes, startMinutes, endMinutes) ? config.lightTheme : config.darkTheme;
}

export default function (pi: ExtensionAPI) {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let currentTheme: string | null = null;

  pi.on("session_start", (_event, ctx: any) => {
    const config = loadConfig(ctx.cwd ?? process.cwd());
    if (!config.enabled) return;

    const applyTheme = () => {
      const nextTheme = selectTheme(config);
      if (nextTheme === currentTheme) return;

      const result = ctx.ui.setTheme(nextTheme);
      if (result?.ok === false) {
        ctx.ui.notify?.(`Theme scheduler could not switch to ${nextTheme}: ${result.error}`, "warning");
        return;
      }
      currentTheme = nextTheme;
    };

    applyTheme();
    intervalId = setInterval(applyTheme, config.pollIntervalMs);
  });

  pi.on("session_shutdown", () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });
}
