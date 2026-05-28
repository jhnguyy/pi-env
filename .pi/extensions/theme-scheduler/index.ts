import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ThemeSchedulerConfig {
  enabled: boolean;
  lightTheme: string;
  darkTheme: string;
  lightStart: string;
  lightEnd: string;
  pollIntervalMs: number;
}

interface RawThemeSchedulerConfig {
  enabled?: unknown;
  lightTheme?: unknown;
  darkTheme?: unknown;
  lightStart?: unknown;
  lightEnd?: unknown;
  pollIntervalMs?: unknown;
}

const DEFAULT_CONFIG: ThemeSchedulerConfig = {
  enabled: false,
  lightTheme: "gruvbox-light",
  darkTheme: "gruvbox-dark",
  lightStart: "10:00",
  lightEnd: "16:00",
  pollIntervalMs: 60_000,
};

function readThemeSchedulerBlock(path: string): RawThemeSchedulerConfig | null {
  if (!existsSync(path)) return null;

  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as { themeScheduler?: RawThemeSchedulerConfig };
    return settings.themeScheduler ?? null;
  } catch {
    return null;
  }
}

function mergeConfig(base: ThemeSchedulerConfig, raw: RawThemeSchedulerConfig | null): ThemeSchedulerConfig {
  if (!raw) return base;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    lightTheme: typeof raw.lightTheme === "string" && raw.lightTheme.trim() ? raw.lightTheme : base.lightTheme,
    darkTheme: typeof raw.darkTheme === "string" && raw.darkTheme.trim() ? raw.darkTheme : base.darkTheme,
    lightStart: typeof raw.lightStart === "string" && raw.lightStart.trim() ? raw.lightStart : base.lightStart,
    lightEnd: typeof raw.lightEnd === "string" && raw.lightEnd.trim() ? raw.lightEnd : base.lightEnd,
    pollIntervalMs:
      typeof raw.pollIntervalMs === "number" && Number.isFinite(raw.pollIntervalMs) && raw.pollIntervalMs >= 1_000
        ? raw.pollIntervalMs
        : base.pollIntervalMs,
  };
}

export function loadConfig(cwd: string): ThemeSchedulerConfig {
  const globalConfig = readThemeSchedulerBlock(join(getAgentDir(), "settings.json"));
  const projectConfig = readThemeSchedulerBlock(join(cwd, ".pi", "settings.json"));

  return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
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
