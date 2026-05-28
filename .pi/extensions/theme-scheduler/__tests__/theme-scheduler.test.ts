import { describe, expect, it } from "vitest";
import { isWithinWindow, parseTimeOfDay, selectTheme, type ThemeSchedulerConfig } from "../index";

const baseConfig: ThemeSchedulerConfig = {
  enabled: true,
  lightTheme: "gruvbox-light",
  darkTheme: "gruvbox-dark",
  lightStart: "10:00",
  lightEnd: "16:00",
  pollIntervalMs: 60_000,
};

describe("theme-scheduler", () => {
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

  it("treats 10:00 as light and 16:00 as dark", () => {
    expect(selectTheme(baseConfig, new Date(2026, 0, 1, 9, 59))).toBe("gruvbox-dark");
    expect(selectTheme(baseConfig, new Date(2026, 0, 1, 10, 0))).toBe("gruvbox-light");
    expect(selectTheme(baseConfig, new Date(2026, 0, 1, 15, 59))).toBe("gruvbox-light");
    expect(selectTheme(baseConfig, new Date(2026, 0, 1, 16, 0))).toBe("gruvbox-dark");
  });

  it("supports windows that cross midnight", () => {
    expect(isWithinWindow(23 * 60, 22 * 60, 6 * 60)).toBe(true);
    expect(isWithinWindow(3 * 60, 22 * 60, 6 * 60)).toBe(true);
    expect(isWithinWindow(12 * 60, 22 * 60, 6 * 60)).toBe(false);
  });
});
