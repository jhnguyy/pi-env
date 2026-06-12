import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, getNextTransitionDelayMs, isWithinWindow, mergeConfig, parseTimeOfDay, selectTheme, setScheduledTheme, type ThemeSchedulerConfig } from "../index";

const baseConfig: ThemeSchedulerConfig = {
  enabled: true,
  lightTheme: "gruvbox-light",
  darkTheme: "gruvbox-dark",
  lightStart: "09:00",
  lightEnd: "16:00",
};

describe("theme-scheduler", () => {
  it("leaves theme resource registration to the package manifest", async () => {
    const events: string[] = [];
    const { default: registerThemeScheduler } = await import("../index");

    registerThemeScheduler({
      on: (event: string) => {
        events.push(event);
      },
    } as any);

    expect(events).not.toContain("resources_discover");
  });

  it("parses 1000 and 10:00 style time strings", () => {
    expect(parseTimeOfDay("1000")).toBe(600);
    expect(parseTimeOfDay("10:00")).toBe(600);
    expect(parseTimeOfDay("16:00")).toBe(960);
    expect(parseTimeOfDay("7")).toBe(420);
  });

  it("rejects invalid time strings", () => {
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("10:60")).toBeNull();
    expect(parseTimeOfDay("nope")).toBeNull();
  });

  it("treats 09:00 as light and 16:00 as dark", () => {
    expect(selectTheme(baseConfig, new Date(2026, 0, 1, 8, 59))).toBe("gruvbox-dark");
    expect(selectTheme(baseConfig, new Date(2026, 0, 1, 9, 0))).toBe("gruvbox-light");
    expect(selectTheme(baseConfig, new Date(2026, 0, 1, 15, 59))).toBe("gruvbox-light");
    expect(selectTheme(baseConfig, new Date(2026, 0, 1, 16, 0))).toBe("gruvbox-dark");
  });

  it("supports windows that cross midnight", () => {
    expect(isWithinWindow(23 * 60, 22 * 60, 6 * 60)).toBe(true);
    expect(isWithinWindow(3 * 60, 22 * 60, 6 * 60)).toBe(true);
    expect(isWithinWindow(12 * 60, 22 * 60, 6 * 60)).toBe(false);
  });

  it("schedules the next transition instead of polling", () => {
    expect(getNextTransitionDelayMs(baseConfig, new Date(2026, 0, 1, 8, 30))).toBe(30 * 60 * 1000);
    expect(getNextTransitionDelayMs(baseConfig, new Date(2026, 0, 1, 9, 0))).toBe(7 * 60 * 60 * 1000);
    expect(getNextTransitionDelayMs(baseConfig, new Date(2026, 0, 1, 16, 0))).toBe(17 * 60 * 60 * 1000);
  });

  it("does not schedule transitions when lightStart equals lightEnd", () => {
    expect(getNextTransitionDelayMs({ ...baseConfig, lightStart: "10:00", lightEnd: "10:00" })).toBeNull();
  });

  it("is enabled by default so startup applies a theme without settings edits", () => {
    expect(mergeConfig(DEFAULT_CONFIG, {}).enabled).toBe(true);
  });

  it("uses pi's named theme path so scheduled switches apply locally and persist globally", () => {
    const calls: unknown[] = [];
    const ctx = {
      ui: {
        setTheme: (value: unknown) => {
          calls.push(value);
          return { success: true };
        },
      },
    };

    expect(setScheduledTheme(ctx, "gruvbox-dark")).toEqual({ success: true });
    expect(calls).toEqual(["gruvbox-dark"]);
  });
});
