import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BrowserClient, type ControlState } from "./browser";
import { loadBrowserClientConfig } from "./config";

const controlStateSchema = StringEnum(["agent", "human", "unlocked"] as const, {
  description: "Browser control state. Mutation tools refuse to act in human mode.",
});

const targetParameter = {
  target: Type.String({ description: "Browser target name from browser_targets, e.g. local, colima, daily-driver" }),
};

const locatorParameters = {
  role: Type.Optional(Type.String({ description: "ARIA role to locate, e.g. button, textbox, link" })),
  name: Type.Optional(Type.String({ description: "Accessible name for role locator" })),
  text: Type.Optional(Type.String({ description: "Visible text locator" })),
  label: Type.Optional(Type.String({ description: "Form label locator" })),
  placeholder: Type.Optional(Type.String({ description: "Input placeholder locator" })),
  testId: Type.Optional(Type.String({ description: "data-testid locator" })),
  selector: Type.Optional(Type.String({ description: "CSS selector fallback; prefer semantic locators first" })),
  exact: Type.Optional(Type.Boolean({ description: "Use exact matching for supported semantic locators" })),
};

export default function playwrightClientExtension(pi: ExtensionAPI) {
  const browser = new BrowserClient(loadBrowserClientConfig());

  pi.registerTool({
    name: "browser_status",
    label: "Browser Status",
    description: "Report Chrome/CDP connection, configured profile, active page, artifact directory, and control state for a named target.",
    parameters: Type.Object(targetParameter),
    async execute(_toolCallId, params) {
      const text = await browser.status(String(params.target));
      return { content: [{ type: "text", text }], details: { target: String(params.target), controlState: browser.getControlState() } };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser_status"))} ${theme.fg("accent", String(args.target ?? ""))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_control",
    label: "Browser Control",
    description: "Set browser control state to agent, human, or unlocked. Mutation tools refuse in human mode.",
    parameters: Type.Object({ state: controlStateSchema }),
    async execute(_toolCallId, params) {
      const state = params.state as ControlState;
      browser.setControlState(state);
      return { content: [{ type: "text", text: `Browser control state: ${state}` }], details: { state } };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser_control"))} ${theme.fg("accent", String(args.state ?? ""))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_targets",
    label: "Browser Targets",
    description: "List configured Chrome/CDP targets. Other browser tools require one of these target names on every call.",
    parameters: Type.Object({}),
    async execute() {
      const targets = browser.listTargets();
      return { content: [{ type: "text", text: formatTargets(targets) }], details: { targets } };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("browser_targets")), 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_pages",
    label: "Browser Pages",
    description: "List open Chrome pages/tabs for a target and optionally select the active page for that target in this pi session.",
    parameters: Type.Object({
      ...targetParameter,
      action: Type.Optional(StringEnum(["list", "select"] as const, { description: "List pages or select one by id" })),
      pageId: Type.Optional(Type.String({ description: "Page id from browser_pages action=list" })),
    }),
    async execute(_toolCallId, params) {
      const target = String(params.target);
      if (params.action === "select") {
        if (!params.pageId) throw new Error("browser_pages action=select requires pageId");
        const page = await browser.selectPage(target, String(params.pageId));
        return { content: [{ type: "text", text: formatPages([page]) }], details: { action: "select", target, pages: [page], selected: page as typeof page | null } };
      }
      const pages = await browser.listPages(target);
      return { content: [{ type: "text", text: formatPages(pages) }], details: { action: "list", target, pages, selected: null as (typeof pages)[number] | null } };
    },
    renderCall(args, theme) {
      const action = String(args.action ?? "list");
      return new Text(`${theme.fg("toolTitle", theme.bold("browser_pages"))} ${theme.fg("accent", String(args.target ?? ""))} ${theme.fg("muted", action)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Return text/accessibility-oriented state for the active page of a target. Prefer this before screenshot-driven actions.",
    parameters: Type.Object(targetParameter),
    async execute(_toolCallId, params) {
      const text = await browser.snapshot(String(params.target));
      return { content: [{ type: "text", text }], details: { target: String(params.target) } };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser_snapshot"))} ${theme.fg("accent", String(args.target ?? ""))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Capture a screenshot artifact for the active page of a target and return its filesystem path.",
    parameters: Type.Object({
      ...targetParameter,
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page instead of the viewport" })),
    }),
    async execute(_toolCallId, params) {
      const shot = await browser.screenshot(String(params.target), Boolean(params.fullPage));
      const text = [`target: ${shot.target}`, `screenshot: ${shot.path}`, `title: ${shot.title || "(untitled)"}`, `url: ${shot.url}`].join("\n");
      return { content: [{ type: "text", text }], details: shot };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser_screenshot"))} ${theme.fg("accent", String(args.target ?? ""))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate the active page of a target to a URL. Refuses while browser control state is human.",
    parameters: Type.Object({ ...targetParameter, url: Type.String({ description: "URL to open in the active page" }) }),
    async execute(_toolCallId, params) {
      const result = await browser.navigate(String(params.target), String(params.url));
      return { content: [{ type: "text", text: `target: ${result.target}\nnavigated: ${result.title || "(untitled)"}\n${result.url}` }], details: result };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser_navigate"))} ${theme.fg("accent", String(args.target ?? ""))} ${theme.fg("muted", String(args.url ?? ""))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element in the active page of a target using semantic locators first, with selector fallback. Refuses while browser control state is human.",
    parameters: Type.Object({ ...targetParameter, ...locatorParameters }),
    async execute(_toolCallId, params) {
      const result = await browser.click(String(params.target), params);
      return { content: [{ type: "text", text: `target: ${result.target}\nclicked: ${result.locator}\n${result.title || "(untitled)"}\n${result.url}` }], details: result };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser_click"))} ${theme.fg("accent", String(args.target ?? ""))} ${theme.fg("muted", formatLocatorArgs(args))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "Fill or type text into an element on a target using semantic locators, or type into the focused element when no locator is provided. Refuses while browser control state is human.",
    parameters: Type.Object({
      ...targetParameter,
      ...locatorParameters,
      value: Type.String({ description: "Text to enter" }),
      mode: Type.Optional(StringEnum(["fill", "type"] as const, { description: "fill replaces element value; type sends keystrokes. Defaults to fill when a locator is provided, otherwise type." })),
    }),
    async execute(_toolCallId, params) {
      const hasLocator = Boolean(params.role || params.text || params.label || params.placeholder || params.testId || params.selector);
      const mode = (params.mode ?? (hasLocator ? "fill" : "type")) as "fill" | "type";
      const result = await browser.type(String(params.target), params, String(params.value), mode);
      return { content: [{ type: "text", text: `target: ${result.target}\n${result.mode}: ${result.locator}\n${result.title || "(untitled)"}\n${result.url}` }], details: result };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser_type"))} ${theme.fg("accent", String(args.target ?? ""))} ${theme.fg("muted", formatLocatorArgs(args))}`, 0, 0);
    },
  });

  pi.registerCommand("browser-targets", {
    description: "Show configured browser/CDP targets",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatTargets(browser.listTargets()), "info");
    },
  });

  pi.registerCommand("browser-connect", {
    description: "Show Chrome launch guidance and configured targets",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${launchGuidance()}\n\n${formatTargets(browser.listTargets())}`, "info");
    },
  });

  pi.registerCommand("browser-pause", {
    description: "Set browser control state to human",
    handler: async (_args, ctx) => {
      browser.setControlState("human");
      ctx.ui.notify("Browser control state: human", "info");
    },
  });

  pi.registerCommand("browser-resume", {
    description: "Set browser control state to agent",
    handler: async (_args, ctx) => {
      browser.setControlState("agent");
      ctx.ui.notify("Browser control state: agent", "info");
    },
  });
}

function formatTargets(targets: Array<{ name: string; host: string; port: number; protocol: string; path: string; cdpUrl: string; description?: string }>): string {
  if (targets.length === 0) return "No browser targets configured.";
  return targets.map((target) => [
    `- ${target.name}: ${target.cdpUrl}`,
    `  host=${target.host} port=${target.port} protocol=${target.protocol}${target.path ? ` path=${target.path}` : ""}`,
    target.description ? `  ${target.description}` : "",
  ].filter(Boolean).join("\n")).join("\n");
}

function formatPages(pages: Array<{ id: string; title: string; url: string; active: boolean }>): string {
  if (pages.length === 0) return "No browser pages.";
  return pages.map((page) => `${page.active ? "*" : "-"} ${page.id}: ${page.title || "(untitled)"}\n  ${page.url}`).join("\n");
}

function formatLocatorArgs(args: Record<string, unknown>): string {
  for (const key of ["role", "text", "label", "placeholder", "testId", "selector"] as const) {
    const value = args[key];
    if (value) return `${key}=${String(value)}`;
  }
  return "focused element";
}

function launchGuidance(): string {
  return [
    "Start Chrome/Chromium with CDP enabled, for example:",
    'chromium --remote-debugging-port=9222 --user-data-dir="$HOME/.config/pi-browser-default"',
    "Every browser tool call takes a target name. List targets with browser_targets or /browser-targets.",
    "For Colima/Docker containers controlling the host browser: launch Google Chrome on the host with --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222, then pass target=colima.",
    "Custom targets use one shape: playwrightClient.targets is an object keyed by target name, and each target is an object with host plus optional port/protocol/path/description.",
    "Example: {\"playwrightClient\":{\"targets\":{\"mac\":{\"host\":\"host.docker.internal\",\"port\":9222}}}}",
  ].join("\n");
}
