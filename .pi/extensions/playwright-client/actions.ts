import type { BrowserClient, ControlState, LocatorParams, WaitParams } from "./browser";

export const BROWSER_ACTIONS = [
  "back",
  "click",
  "control",
  "forward",
  "history",
  "navigate",
  "newPage",
  "pages",
  "reload",
  "screenshot",
  "snapshot",
  "status",
  "targets",
  "type",
  "wait",
] as const;

export type BrowserAction = typeof BROWSER_ACTIONS[number];
export type TypeMode = "fill" | "type";

export type BrowserArgs = LocatorParams & WaitParams & {
  state?: ControlState;
  pageId?: string;
  pageTitle?: string;
  pageUrl?: string;
  fullPage?: boolean;
  value?: string;
  mode?: TypeMode;
  limit?: number;
};

export interface BrowserActionResult {
  text: string;
  details: unknown;
}

type BrowserActionHandler = (ctx: BrowserActionContext) => Promise<BrowserActionResult>;

interface BrowserActionContext {
  browser: BrowserClient;
  action: BrowserAction;
  target?: string;
  args: BrowserArgs;
}

const TARGETED_ACTIONS = {
  back: async ({ browser, action, target }) => {
    const result = await browser.back(requireTarget(action, target));
    return navigationResult(action, result);
  },
  click: async ({ browser, action, target, args }) => {
    const result = await browser.click(requireTarget(action, target), args);
    return { text: `target: ${result.target}\nclicked: ${result.locator}\n${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
  },
  forward: async ({ browser, action, target }) => {
    const result = await browser.forward(requireTarget(action, target));
    return navigationResult(action, result);
  },
  navigate: async ({ browser, action, target, args }) => {
    if (!args.url) throw new Error("browser action=navigate requires args.url");
    const result = await browser.navigate(requireTarget(action, target), args.url);
    return { text: `target: ${result.target}\nnavigated: ${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
  },
  newPage: async ({ browser, action, target }) => {
    const result = await browser.newPage(requireTarget(action, target));
    return { text: `target: ${result.target}\nnewPage: ${result.id}\n${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
  },
  pages: async ({ browser, action, target, args }) => {
    const targetName = requireTarget(action, target);
    if (args.pageId || args.pageTitle || args.pageUrl) {
      const page = await browser.selectPage(targetName, { pageId: args.pageId, title: args.pageTitle, url: args.pageUrl });
      return { text: formatPages([page]), details: { action, target: targetName, pages: [page], selected: page } };
    }
    const pages = await browser.listPages(targetName);
    return { text: formatPages(pages), details: { action, target: targetName, pages, selected: null } };
  },
  reload: async ({ browser, action, target }) => {
    const result = await browser.reload(requireTarget(action, target));
    return navigationResult(action, result);
  },
  screenshot: async ({ browser, action, target, args }) => {
    const shot = await browser.screenshot(requireTarget(action, target), Boolean(args.fullPage));
    const text = [`target: ${shot.target}`, `screenshot: ${shot.path}`, `title: ${shot.title || "(untitled)"}`, `url: ${shot.url}`].join("\n");
    return { text, details: { action, ...shot } };
  },
  snapshot: async ({ browser, action, target }) => {
    const targetName = requireTarget(action, target);
    return { text: await browser.snapshot(targetName), details: { action, target: targetName } };
  },
  status: async ({ browser, action, target }) => {
    const targetName = requireTarget(action, target);
    const text = await browser.status(targetName);
    return { text, details: { action, target: targetName, controlState: browser.getControlState() } };
  },
  type: async ({ browser, action, target, args }) => {
    if (args.value === undefined) throw new Error("browser action=type requires args.value");
    const hasLocator = Boolean(args.role || args.text || args.label || args.placeholder || args.testId || args.selector);
    const mode = args.mode ?? (hasLocator ? "fill" : "type");
    const result = await browser.type(requireTarget(action, target), args, args.value, mode);
    return { text: `target: ${result.target}\n${result.mode}: ${result.locator}\n${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
  },
  wait: async ({ browser, action, target, args }) => {
    const result = await browser.wait(requireTarget(action, target), args);
    return { text: `target: ${result.target}\nwaited: ${result.waitedFor}\n${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
  },
} satisfies Partial<Record<BrowserAction, BrowserActionHandler>>;

const ACTION_HANDLERS = {
  back: TARGETED_ACTIONS.back,
  click: TARGETED_ACTIONS.click,
  forward: TARGETED_ACTIONS.forward,
  navigate: TARGETED_ACTIONS.navigate,
  newPage: TARGETED_ACTIONS.newPage,
  pages: TARGETED_ACTIONS.pages,
  reload: TARGETED_ACTIONS.reload,
  screenshot: TARGETED_ACTIONS.screenshot,
  snapshot: TARGETED_ACTIONS.snapshot,
  status: TARGETED_ACTIONS.status,
  type: TARGETED_ACTIONS.type,
  wait: TARGETED_ACTIONS.wait,
  control: async ({ browser, action, args }) => {
    if (!args.state) throw new Error("browser action=control requires args.state");
    browser.setControlState(args.state);
    return { text: `Browser control state: ${args.state}`, details: { action, state: args.state } };
  },
  history: async ({ browser, action, args }) => {
    const entries = browser.getHistory(args.limit);
    return { text: formatHistory(entries), details: { action, history: entries } };
  },
  targets: async ({ browser, action }) => {
    const targets = browser.listTargets();
    return { text: formatTargets(targets), details: { action, targets } };
  },
} satisfies Record<BrowserAction, BrowserActionHandler>;

export function executeBrowserAction(browser: BrowserClient, action: BrowserAction, target: string | undefined, args: BrowserArgs): Promise<BrowserActionResult> {
  return ACTION_HANDLERS[action]({ browser, action, target, args });
}

function navigationResult(action: BrowserAction, result: { title: string; url: string; target: string }): BrowserActionResult {
  return { text: `target: ${result.target}\n${action}: ${result.title || "(untitled)"}\n${result.url}`, details: { action, ...result } };
}

function requireTarget(action: string, target: string | undefined): string {
  if (!target) throw new Error(`browser action=${action} requires target. Use action=targets to list configured targets.`);
  return target;
}

export function formatTargets(targets: Array<{ name: string; host: string; port: number; protocol: string; path: string; cdpUrl: string; description?: string }>): string {
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

export function formatActionSummary(action: string, args: Record<string, unknown> | undefined): string {
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

export function translateBrowserError(error: unknown): string {
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
