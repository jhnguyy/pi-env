import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";

import type { SubagentJob } from "../jobs";
import { renderActiveJobStatusSlot } from "../session-runtime";

it("recolors the same mounted native widget without a job event, then updates and removes jobs", async () => {
  const sdk = new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { InteractiveMode } = await import(
    new URL("modes/interactive/interactive-mode.js", sdk).href
  );
  const { InteractiveThemeController } = await import(
    new URL("modes/interactive/theme/theme-controller.js", sdk).href
  );
  const { loadThemeFromPath, initTheme, stopThemeWatcher } = await import(
    new URL("modes/interactive/theme/theme.js", sdk).href
  );
  const dark = loadThemeFromPath(
    new URL("../../../themes/gruvbox-dark.json", import.meta.url).pathname,
  );
  const light = loadThemeFromPath(
    new URL("../../../themes/gruvbox-light.json", import.meta.url).pathname,
  );
  const below = new Container();
  const above = new Container();
  const ui = {
    invalidate: () => {
      above.invalidate();
      below.invalidate();
    },
    requestRender: vi.fn(),
    onTerminalColorSchemeChange: () => () => {},
    setTerminalColorSchemeNotifications: () => {},
  };
  const controller = new InteractiveThemeController(ui, {
    initialThemeSetting: "dark",
    getSettingsManager: () => ({ getThemeSetting: () => "dark" }),
    showError: (message: string) => {
      throw new Error(message);
    },
    onChanged: () => ui.requestRender(),
  });
  // Exercise native widget mounting and theme invalidation without starting a terminal or session.
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    ui,
    themeController: controller,
    extensionWidgetsAbove: new Map(),
    extensionWidgetsBelow: new Map(),
    widgetContainerAbove: above,
    widgetContainerBelow: below,
  });
  const ctx = { mode: "tui", hasUI: true, ui: host.createExtensionUIContext() } as ExtensionContext;
  const setWidget = vi.spyOn(ctx.ui, "setWidget");
  const jobs = [
    { id: "1", name: "audit", status: "running", createdAt: "2026-01-01" },
    { id: "2", name: "tests", status: "queued", createdAt: "2026-01-02" },
    { id: "3", name: "cancel", status: "cancelling", createdAt: "2026-01-03" },
  ] as SubagentJob[];
  const plain = () => below.render(100).map((line) => stripAnsi(line).trim());

  try {
    ctx.ui.setTheme(dark);
    renderActiveJobStatusSlot(jobs, ctx);
    const mounted = host.extensionWidgetsBelow.get("subagents");
    const first = below.render(100);
    expect(plain()).toEqual([
      "subagent audit [running]",
      "subagent tests [queued]",
      "subagent cancel [cancelling]",
    ]);
    expect(first[0]).toContain(dark.fg("accent", "audit"));

    ctx.ui.setTheme(light);
    const second = below.render(100);
    expect(host.extensionWidgetsBelow.get("subagents")).toBe(mounted);
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(second).not.toEqual(first);
    expect(second[0]).toContain(light.fg("toolTitle", light.bold("subagent")));
    expect(second[0]).toContain(light.fg("accent", "audit"));
    expect(second[0]).not.toContain(dark.fg("accent", "audit"));
    expect(second[1]).toContain(light.fg("dim", "[queued]"));
    expect(second[2]).toContain(light.fg("warning", "[cancelling]"));
    expect(plain()).toEqual(first.map((line: string) => stripAnsi(line).trim()));
    expect(below.render(12).every((line) => visibleWidth(line) <= 12)).toBe(true);

    renderActiveJobStatusSlot([{ ...jobs[1]!, status: "running" }], ctx);
    expect(plain()).toEqual(["subagent tests [running]"]);
    renderActiveJobStatusSlot(
      Array.from({ length: 12 }, (_, index) => ({ ...jobs[0]!, name: `child-${index}` })),
      ctx,
    );
    expect(plain()).toHaveLength(11);
    expect(plain().at(-1)).toBe("... (widget truncated)");
    renderActiveJobStatusSlot([{ ...jobs[1]!, status: "completed" }], ctx);
    expect(host.extensionWidgetsBelow.has("subagents")).toBe(false);
    expect(below.render(100)).toEqual([]);
    renderActiveJobStatusSlot([], ctx);
    expect(below.render(100)).toEqual([]);
  } finally {
    controller.dispose();
    stopThemeWatcher();
    initTheme("dark");
  }
});
