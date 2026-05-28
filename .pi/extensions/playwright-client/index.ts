import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { txt } from "../_shared/result";
import { BrowserClient, type ControlState, type LocatorParams, type WaitParams } from "./browser";
import { loadBrowserClientConfig } from "./config";
import type { ExtToolRegistration } from "../subagent/types";

const browserActionSchema = StringEnum([
  "targets",
  "status",
  "control",
  "pages",
  "snapshot",
  "screenshot",
  "navigate",
  "newPage",
  "back",
  "forward",
  "reload",
  "wait",
  "history",
  "click",
  "type",
] as const, { description: "Browser action to perform" });

type BrowserAction = "targets" | "status" | "control" | "pages" | "snapshot" | "screenshot" | "navigate" | "newPage" | "back" | "forward" | "reload" | "wait" | "history" | "click" | "type";
type TypeMode = "fill" | "type";
type BrowserCommandContext = { ui: { notify(message: string, level?: "info" | "warning" | "error"): void } };

type BrowserArgs = LocatorParams & WaitParams & {
  state?: ControlState;
  pageId?: string;
  pageTitle?: string;
  pageUrl?: string;
  fullPage?: boolean;
  value?: string;
  mode?: TypeMode;
  limit?: number;
};

export default function playwrightClientExtension(pi: ExtensionAPI) {
  const browser = new BrowserClient(loadBrowserClientConfig());

  const browserTool = {
    name: "browser",
    label: "Browser",
    description: DESCRIPTION,
    promptSnippet: "Control a configured Chrome/Chromium CDP target: list targets/pages, snapshot, navigate, wait, click, type, screenshot.",
    promptGuidelines: [
      "Use browser action=targets first when you need to discover configured browser targets.",
      "Use browser action=snapshot before browser action=screenshot; snapshots provide text/accessibility state with less context cost.",
      "Use semantic browser locators first for click/type: role+name, label, text, placeholder, or testId. Use selector only as a fallback.",
      "Every browser action except targets, control, and history requires target, for example target=local for an SSH-forwarded daily-driver Chromium.",
    ],
    parameters: Type.Object({
      action: browserActionSchema,
      target: Type.Optional(Type.String({ description: "Browser target name from action=targets, e.g. local or a configured settings target" })),
      args: Type.Optional(Type.Object({
        state: Type.Optional(StringEnum(["agent", "human", "unlocked"] as const, { description: "Control state for action=control" })),
        pageId: Type.Optional(Type.String({ description: "Page id for action=pages selection; omit to list pages" })),
        pageTitle: Type.Optional(Type.String({ description: "Title substring for action=pages selection" })),
        pageUrl: Type.Optional(Type.String({ description: "URL substring for action=pages selection" })),
        fullPage: Type.Optional(Type.Boolean({ description: "Capture full scrollable page for action=screenshot" })),
        url: Type.Optional(Type.String({ description: "URL for action=navigate, or URL/string pattern for action=wait" })),
        loadState: Type.Optional(StringEnum(["domcontentloaded", "load", "networkidle"] as const, { description: "Load state for action=wait" })),
        locatorState: Type.Optional(StringEnum(["attached", "detached", "visible", "hidden"] as const, { description: "Locator state for action=wait with a locator" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds for action=wait" })),
        limit: Type.Optional(Type.Number({ description: "Number of history entries for action=history" })),
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
    async execute(_toolCallId: string, params: { action: unknown; target?: unknown; args?: unknown }) {
      const action = params.action as BrowserAction;
      const args = (params.args ?? {}) as BrowserArgs;
      const target = typeof params.target === "string" ? params.target : undefined;
      try {
        const result = await executeBrowserAction(browser, action, target, args);
        const page = target ? await browser.currentPageSummary(target).catch(() => undefined) : undefined;
        if (action !== "history") browser.recordHistory({ action, target, pageTitle: page?.title, pageUrl: page?.url, result: result.text.split("\n")[0] });
        return { content: [txt(result.text)], details: result.details };
      } catch (error) {
        const page = target ? await browser.currentPageSummary(target).catch(() => undefined) : undefined;
        const message = translateBrowserError(error);
        if (action !== "history") browser.recordHistory({ action, target, pageTitle: page?.title, pageUrl: page?.url, error: message });
        throw new Error(message);
      }
    },
    renderCall(args: Record<string, unknown>, theme: { fg(scope: string, text: string): string; bold(text: string): string }) {
      const action = String(args.action ?? "");
      const target = typeof args.target === "string" ? ` ${args.target}` : "";
      const summary = formatActionSummary(action, args.args as Record<string, unknown> | undefined);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("browser"))} ${theme.fg("accent", action)}${theme.fg("muted", target)}${summary ? " " + theme.fg("muted", summary) : ""}`,
        0,
        0,
      );
    },
  };

  pi.registerTool(browserTool);
  pi.on("session_start", () => {
    pi.events.emit("agent-tools:register", { tool: browserTool as AgentTool<any, any>, capabilities: ["read", "write", "execute"] } satisfies ExtToolRegistration);
  });

  pi.registerCommand("browser-targets", {
    description: "Show configured browser/CDP targets",
    handler: async (_args: string, ctx: BrowserCommandContext) => {
      ctx.ui.notify(formatTargets(browser.listTargets()), "info");
    },
  });

  pi.registerCommand("browser-connect", {
    description: "Show Chrome launch guidance and configured targets",
    handler: async (_args: string, ctx: BrowserCommandContext) => {
      ctx.ui.notify(`${launchGuidance()}\n\n${formatTargets(browser.listTargets())}`, "info");
    },
  });

  pi.registerCommand("browser-pause", {
    description: "Set browser control state to human",
    handler: async (_args: string, ctx: BrowserCommandContext) => {
      browser.setControlState("human");
      ctx.ui.notify("Browser control state: human", "info");
    },
  });

  pi.registerCommand("browser-resume", {
    description: "Set browser control state to agent",
    handler: async (_args: string, ctx: BrowserCommandContext) => {
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
      if (args.pageId || args.pageTitle || args.pageUrl) {
        const page = await browser.selectPage(targetName, { pageId: args.pageId, title: args.pageTitle, url: args.pageUrl });
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
    case "newPage": {
      const targetName = requireTarget(action, target);
      const result = await browser.newPage(targetName);
      return { text: `target: ${result.target}\nnewPage: ${result.id}\n${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
    }
    case "back":
    case "forward":
    case "reload": {
      const targetName = requireTarget(action, target);
      const result = action === "back" ? await browser.back(targetName) : action === "forward" ? await browser.forward(targetName) : await browser.reload(targetName);
      return { text: `target: ${result.target}\n${action}: ${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
    }
    case "wait": {
      const targetName = requireTarget(action, target);
      const result = await browser.wait(targetName, args);
      return { text: `target: ${result.target}\nwaited: ${result.waitedFor}\n${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
    }
    case "history": {
      const entries = browser.getHistory(args.limit);
      return { text: formatHistory(entries), details: { action, history: entries } };
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

function formatHistory(entries: Array<{ timestamp: string; action: string; target?: string; pageTitle?: string; pageUrl?: string; result?: string; error?: string }>): string {
  if (entries.length === 0) return "No browser action history.";
  return entries.map((entry) => [
    `- ${entry.timestamp} action=${entry.action}${entry.target ? ` target=${entry.target}` : ""}`,
    entry.pageTitle || entry.pageUrl ? `  page: ${entry.pageTitle || "(untitled)"} — ${entry.pageUrl || ""}` : "",
    entry.result ? `  result: ${entry.result}` : "",
    entry.error ? `  error: ${entry.error}` : "",
  ].filter(Boolean).join("\n")).join("\n");
}

function formatActionSummary(action: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if ((action === "navigate" || action === "wait") && args.url) return String(args.url);
  if (action === "control" && args.state) return String(args.state);
  if (action === "pages") {
    if (args.pageId) return `page=${String(args.pageId)}`;
    if (args.pageTitle) return `title~=${String(args.pageTitle)}`;
    if (args.pageUrl) return `url~=${String(args.pageUrl)}`;
  }
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

function translateBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const guidance: string[] = [];
  if (lower.includes("unable to connect") || lower.includes("econnrefused") || lower.includes("connect") || lower.includes("target closed")) {
    guidance.push("Next steps: run browser action=targets to confirm the target name, start Chrome with --remote-debugging-port, and verify the CDP URL is reachable from this pi process.");
  }
  if (lower.includes("no pages are open") || lower.includes("page") && (lower.includes("closed") || lower.includes("crash") || lower.includes("detached"))) {
    guidance.push("Next steps: run browser action=pages to refresh page state, or browser action=newPage to create a fresh active page.");
  }
  if (lower.includes("timeout") || lower.includes("waiting for") || lower.includes("strict mode violation")) {
    guidance.push("Next steps: run browser action=snapshot to inspect current content; try a more specific semantic locator, selector fallback, or browser action=wait with a longer timeout.");
  }
  if (lower.includes("control state is human")) {
    guidance.push("Next steps: wait for the human, or use browser action=control args.state=agent when control should return to the agent.");
  }
  return [message, ...guidance].join("\n");
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
  "- pages: list pages for target; pass args.pageId, args.pageTitle, or args.pageUrl to select the active page.",
  "- snapshot: return text/accessibility state for the active page.",
  "- screenshot: capture the active page to an artifact path; args.fullPage optional.",
  "- navigate: navigate active page; requires args.url.",
  "- newPage: create a new page with context.newPage() and make it active.",
  "- back / forward / reload: use Playwright page navigation primitives on the active page.",
  "- wait: wait for load state, URL, or locator; pass args.url, locator args, args.loadState, args.locatorState, and/or args.timeout.",
  "- history: show recent browser actions with target, page, result, or error.",
  "- click: click by semantic locator; pass args.role+args.name, text, label, placeholder, testId, or selector.",
  "- type: fill/type text; requires args.value and optional semantic locator. Defaults to fill when a locator is provided, otherwise type into focused element.",
].join("\n");
