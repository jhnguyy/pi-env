import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { txt } from "../_shared/result";
import { BrowserClient, type ControlState, type LocatorParams } from "./browser";
import { loadBrowserClientConfig } from "./config";

const browserActionSchema = StringEnum([
  "targets",
  "status",
  "control",
  "pages",
  "snapshot",
  "screenshot",
  "navigate",
  "click",
  "type",
] as const, { description: "Browser action to perform" });

type BrowserAction = "targets" | "status" | "control" | "pages" | "snapshot" | "screenshot" | "navigate" | "click" | "type";
type TypeMode = "fill" | "type";

type BrowserArgs = LocatorParams & {
  state?: ControlState;
  pageId?: string;
  fullPage?: boolean;
  url?: string;
  value?: string;
  mode?: TypeMode;
};

export default function playwrightClientExtension(pi: ExtensionAPI) {
  const browser = new BrowserClient(loadBrowserClientConfig());

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: DESCRIPTION,
    promptSnippet: "Control a configured Chrome/Chromium CDP target: list targets/pages, snapshot, navigate, click, type, screenshot.",
    promptGuidelines: [
      "Use browser action=targets first when you need to discover configured browser targets.",
      "Use browser action=snapshot before browser action=screenshot; snapshots provide text/accessibility state with less context cost.",
      "Use semantic browser locators first for click/type: role+name, label, text, placeholder, or testId. Use selector only as a fallback.",
      "Every browser action except targets and control requires target, for example target=local for an SSH-forwarded daily-driver Chromium.",
    ],
    parameters: Type.Object({
      action: browserActionSchema,
      target: Type.Optional(Type.String({ description: "Browser target name from action=targets, e.g. local or a configured settings target" })),
      args: Type.Optional(Type.Object({
        state: Type.Optional(StringEnum(["agent", "human", "unlocked"] as const, { description: "Control state for action=control" })),
        pageId: Type.Optional(Type.String({ description: "Page id for action=pages selection; omit to list pages" })),
        fullPage: Type.Optional(Type.Boolean({ description: "Capture full scrollable page for action=screenshot" })),
        url: Type.Optional(Type.String({ description: "URL for action=navigate" })),
        role: Type.Optional(Type.String({ description: "ARIA role locator for click/type, e.g. button, textbox, link" })),
        name: Type.Optional(Type.String({ description: "Accessible name for role locator" })),
        text: Type.Optional(Type.String({ description: "Visible text locator" })),
        label: Type.Optional(Type.String({ description: "Form label locator" })),
        placeholder: Type.Optional(Type.String({ description: "Input placeholder locator" })),
        testId: Type.Optional(Type.String({ description: "data-testid locator" })),
        selector: Type.Optional(Type.String({ description: "CSS selector fallback; prefer semantic locators first" })),
        exact: Type.Optional(Type.Boolean({ description: "Use exact matching for supported semantic locators" })),
        value: Type.Optional(Type.String({ description: "Text to enter for action=type" })),
        mode: Type.Optional(StringEnum(["fill", "type"] as const, { description: "For action=type: fill replaces element value; type sends keystrokes" })),
      })),
    }),
    async execute(_toolCallId, params) {
      const action = params.action as BrowserAction;
      const args = (params.args ?? {}) as BrowserArgs;
      const target = typeof params.target === "string" ? params.target : undefined;
      const result = await executeBrowserAction(browser, action, target, args);
      return { content: [txt(result.text)], details: result.details };
    },
    renderCall(args, theme) {
      const action = String(args.action ?? "");
      const target = typeof args.target === "string" ? ` ${args.target}` : "";
      const summary = formatActionSummary(action, args.args as Record<string, unknown> | undefined);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("browser"))} ${theme.fg("accent", action)}${theme.fg("muted", target)}${summary ? " " + theme.fg("muted", summary) : ""}`,
        0,
        0,
      );
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

async function executeBrowserAction(browser: BrowserClient, action: BrowserAction, target: string | undefined, args: BrowserArgs): Promise<{ text: string; details: unknown }> {
  switch (action) {
    case "targets": {
      const targets = browser.listTargets();
      return { text: formatTargets(targets), details: { action, targets } };
    }
    case "control": {
      if (!args.state) throw new Error("browser action=control requires args.state");
      browser.setControlState(args.state);
      return { text: `Browser control state: ${args.state}`, details: { action, state: args.state } };
    }
    case "status": {
      const targetName = requireTarget(action, target);
      const text = await browser.status(targetName);
      return { text, details: { action, target: targetName, controlState: browser.getControlState() } };
    }
    case "pages": {
      const targetName = requireTarget(action, target);
      if (args.pageId) {
        const page = await browser.selectPage(targetName, args.pageId);
        return { text: formatPages([page]), details: { action, target: targetName, pages: [page], selected: page } };
      }
      const pages = await browser.listPages(targetName);
      return { text: formatPages(pages), details: { action, target: targetName, pages, selected: null } };
    }
    case "snapshot": {
      const targetName = requireTarget(action, target);
      return { text: await browser.snapshot(targetName), details: { action, target: targetName } };
    }
    case "screenshot": {
      const targetName = requireTarget(action, target);
      const shot = await browser.screenshot(targetName, Boolean(args.fullPage));
      const text = [`target: ${shot.target}`, `screenshot: ${shot.path}`, `title: ${shot.title || "(untitled)"}`, `url: ${shot.url}`].join("\n");
      return { text, details: { action, ...shot } };
    }
    case "navigate": {
      const targetName = requireTarget(action, target);
      if (!args.url) throw new Error("browser action=navigate requires args.url");
      const result = await browser.navigate(targetName, args.url);
      return { text: `target: ${result.target}\nnavigated: ${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
    }
    case "click": {
      const targetName = requireTarget(action, target);
      const result = await browser.click(targetName, args);
      return { text: `target: ${result.target}\nclicked: ${result.locator}\n${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
    }
    case "type": {
      const targetName = requireTarget(action, target);
      if (args.value === undefined) throw new Error("browser action=type requires args.value");
      const hasLocator = Boolean(args.role || args.text || args.label || args.placeholder || args.testId || args.selector);
      const mode = args.mode ?? (hasLocator ? "fill" : "type");
      const result = await browser.type(targetName, args, args.value, mode);
      return { text: `target: ${result.target}\n${result.mode}: ${result.locator}\n${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
    }
  }
}

function requireTarget(action: string, target: string | undefined): string {
  if (!target) throw new Error(`browser action=${action} requires target. Use action=targets to list configured targets.`);
  return target;
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

function formatActionSummary(action: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if (action === "navigate" && args.url) return String(args.url);
  if (action === "control" && args.state) return String(args.state);
  if (action === "pages" && args.pageId) return `page=${String(args.pageId)}`;
  if (action === "type" && args.value) return formatLocatorArgs(args);
  if (action === "click") return formatLocatorArgs(args);
  return "";
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
    "Use browser action=targets to list targets. Other browser actions require target.",
    "Configure custom targets in settings.json under playwrightClient.targets.",
    "Example: {\"playwrightClient\":{\"targets\":{\"daily-driver\":{\"host\":\"127.0.0.1\",\"port\":9222,\"description\":\"SSH reverse-forwarded Chromium\"}}}}",
  ].join("\n");
}

const DESCRIPTION = [
  "Control a configured Chrome/Chromium browser over the Chrome DevTools Protocol.",
  "This is a single action tool: pass action, optional target, and action-specific args.",
  "Actions:",
  "- targets: list configured targets; no target required.",
  "- status: connect to target and report pages/profile/control state.",
  "- control: set side-by-side control state with args.state = agent | human | unlocked; no target required.",
  "- pages: list pages for target; pass args.pageId to select the active page.",
  "- snapshot: return text/accessibility state for the active page.",
  "- screenshot: capture the active page to an artifact path; args.fullPage optional.",
  "- navigate: navigate active page; requires args.url.",
  "- click: click by semantic locator; pass args.role+args.name, text, label, placeholder, testId, or selector.",
  "- type: fill/type text; requires args.value and optional semantic locator. Defaults to fill when a locator is provided, otherwise type into focused element.",
].join("\n");
