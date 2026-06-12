import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSettingsBlock, type SettingsBlock } from "../_shared/settings";

export interface ThemeSchedulerConfig {
  enabled: boolean;
  lightTheme: string;
  darkTheme: string;
  lightStart: string;
  lightEnd: string;
}

export const DEFAULT_CONFIG: ThemeSchedulerConfig = {
  enabled: true,
  lightTheme: "gruvbox-light",
  darkTheme: "gruvbox-dark",
  lightStart: "09:00",
  lightEnd: "16:00",
};

export function mergeConfig(base: ThemeSchedulerConfig, raw: SettingsBlock | null): ThemeSchedulerConfig {
  if (!raw) return base;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    lightTheme: typeof raw.lightTheme === "string" && raw.lightTheme.trim() ? raw.lightTheme : base.lightTheme,
    darkTheme: typeof raw.darkTheme === "string" && raw.darkTheme.trim() ? raw.darkTheme : base.darkTheme,
    lightStart: typeof raw.lightStart === "string" && raw.lightStart.trim() ? raw.lightStart : base.lightStart,
    lightEnd: typeof raw.lightEnd === "string" && raw.lightEnd.trim() ? raw.lightEnd : base.lightEnd,
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

function dateAtMinutes(base: Date, minutes: number): Date {
  const next = new Date(base);
  next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return next;
}

export function getNextTransitionDelayMs(config: ThemeSchedulerConfig, now = new Date()): number | null {
  const startMinutes = parseTimeOfDay(config.lightStart) ?? parseTimeOfDay(DEFAULT_CONFIG.lightStart)!;
  const endMinutes = parseTimeOfDay(config.lightEnd) ?? parseTimeOfDay(DEFAULT_CONFIG.lightEnd)!;
  if (startMinutes === endMinutes) return null;

  const candidates = [dateAtMinutes(now, startMinutes), dateAtMinutes(now, endMinutes)];
  for (const candidate of [...candidates]) {
    const tomorrow = new Date(candidate);
    tomorrow.setDate(tomorrow.getDate() + 1);
    candidates.push(tomorrow);
  }

  const nextTransition = candidates
    .filter((candidate) => candidate.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return nextTransition ? nextTransition.getTime() - now.getTime() : null;
}

export function setScheduledTheme(ctx: any, themeName: string): { success: boolean; error?: string } {
  // Passing the theme name applies it locally and persists it globally through
  // pi's SettingsManager. SettingsManager serializes writes with a file lock,
  // so concurrent pi processes cannot corrupt settings.json.
  return ctx.ui.setTheme(themeName);
}

export default function (pi: ExtensionAPI) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let currentTheme: string | null = null;

  const clearScheduler = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  pi.on("session_start", (_event, ctx: any) => {
    clearScheduler();

    const config = loadConfig(ctx.cwd ?? process.cwd());
    if (!config.enabled) return;

    const scheduleNextTransition = () => {
      const delayMs = getNextTransitionDelayMs(config);
      if (delayMs === null) return;

      timeoutId = setTimeout(applyThemeAndScheduleNext, delayMs);
    };

    const applyThemeAndScheduleNext = () => {
      timeoutId = null;
      const nextTheme = selectTheme(config);
      if (nextTheme !== currentTheme) {
        const result = setScheduledTheme(ctx, nextTheme);
        if (result.success === false) {
          ctx.ui.notify?.(`Theme scheduler could not switch to ${nextTheme}: ${result.error}`, "warning");
        } else {
          currentTheme = nextTheme;
        }
      }

      scheduleNextTransition();
    };

    timeoutId = setTimeout(applyThemeAndScheduleNext, 0);
  });

  pi.on("session_shutdown", clearScheduler);
}
