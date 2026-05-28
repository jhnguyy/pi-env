import type { BrowserClientConfig, BrowserTarget } from "./config";
import { BrowserArtifacts } from "./artifacts";

type BrowserLike = {
  contexts(): ContextLike[];
  close(): Promise<void>;
};
type ContextLike = {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
};
type LocatorLike = {
  click(options?: { timeout?: number }): Promise<unknown>;
  fill(value: string, options?: { timeout?: number }): Promise<unknown>;
  type(value: string, options?: { timeout?: number }): Promise<unknown>;
  waitFor(options?: { state?: LocatorWaitState; timeout?: number }): Promise<unknown>;
  innerText(options?: { timeout?: number }): Promise<string>;
  ariaSnapshot?(options?: { timeout?: number }): Promise<string>;
};
type LoadState = "domcontentloaded" | "load" | "networkidle";
type LocatorWaitState = "attached" | "detached" | "visible" | "hidden";
type PageLike = {
  title(): Promise<string>;
  url(): string;
  goto(url: string, options?: { waitUntil?: Extract<LoadState, "domcontentloaded" | "load">; timeout?: number }): Promise<unknown>;
  goBack(options?: { waitUntil?: LoadState; timeout?: number }): Promise<unknown>;
  goForward(options?: { waitUntil?: LoadState; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: LoadState; timeout?: number }): Promise<unknown>;
  waitForLoadState(state?: LoadState, options?: { timeout?: number }): Promise<unknown>;
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<unknown>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  locator(selector: string): LocatorLike;
  getByRole?(role: string, options?: { name?: string; exact?: boolean }): LocatorLike;
  getByText?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByLabel?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByPlaceholder?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByTestId?(testId: string): LocatorLike;
  keyboard: { type(value: string): Promise<unknown> };
};
type PlaywrightModule = {
  chromium: {
    connectOverCDP(endpointURL: string): Promise<BrowserLike>;
  };
};
export type ControlState = "agent" | "human" | "unlocked";
export interface PageSummary {
  id: string;
  index: number;
  title: string;
  url: string;
  active: boolean;
}
export interface LocatorParams {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  selector?: string;
  exact?: boolean;
}
export interface PageSelectionParams {
  pageId?: string;
  title?: string;
  url?: string;
}
export interface WaitParams extends LocatorParams {
  url?: string;
  loadState?: LoadState;
  locatorState?: LocatorWaitState;
  timeout?: number;
}
export interface BrowserActionHistoryEntry {
  timestamp: string;
  action: string;
  target?: string;
  pageTitle?: string;
  pageUrl?: string;
  result?: string;
  error?: string;
}
const HISTORY_LIMIT = 50;

export class BrowserClient {
  private readonly browsers = new Map<string, BrowserLike>();
  private readonly activePageIndexes = new Map<string, number>();
  private readonly history: BrowserActionHistoryEntry[] = [];
  private controlState: ControlState = "agent";
  private readonly artifacts: BrowserArtifacts;
  constructor(private readonly config: BrowserClientConfig) {
    this.artifacts = new BrowserArtifacts(config.artifactDir);
  }
  setControlState(state: ControlState): void {
    this.controlState = state;
  }
  getControlState(): ControlState {
    return this.controlState;
  }
  listTargets(): BrowserTarget[] {
    return this.config.targets;
  }
  getHistory(limit = HISTORY_LIMIT): BrowserActionHistoryEntry[] {
    return this.history.slice(-Math.max(0, limit));
  }
  recordHistory(entry: Omit<BrowserActionHistoryEntry, "timestamp">): void {
    this.history.push({ timestamp: new Date().toISOString(), ...entry });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }
  async status(targetName: string): Promise<string> {
    const target = this.targetByName(targetName);
    const connected = await this.tryConnect(target);
    const pages = connected ? await this.listPages(target.name) : [];
    const active = pages.find((page) => page.active);
    return [
      `backend: chrome-cdp`,
      `connected: ${connected ? "yes" : "no"}`,
      `target: ${target.name}`,
      `cdpUrl: ${target.cdpUrl}`,
      `targets: ${this.config.targets.map((candidate) => candidate.name).join(", ")}`,
      `profile: ${this.config.profileName}`,
      `profilePath: ${this.config.profilePath}`,
      `artifactDir: ${this.config.artifactDir}`,
      `controlState: ${this.controlState}`,
      `pages: ${pages.length}`,
      active ? `activePage: ${active.id} ${active.title || "(untitled)"} — ${active.url}` : `activePage: none`,
    ].join("\n");
  }
  async listPages(targetName: string): Promise<PageSummary[]> {
    const target = this.targetByName(targetName);
    await this.ensureConnected(target);
    const pages = await this.pages(target);
    const activePageIndex = this.activePageIndex(target.name, pages.length);
    return Promise.all(pages.map(async (page, index) => ({
      id: String(index),
      index,
      title: await page.title().catch(() => ""),
      url: safeUrl(page),
      active: index === activePageIndex,
    })));
  }
  async selectPage(targetName: string, selection: PageSelectionParams): Promise<PageSummary> {
    const pages = await this.listPages(targetName);
    const match = selectPageSummary(pages, selection, targetName);
    this.activePageIndexes.set(targetName, match.index);
    return (await this.listPages(targetName))[match.index];
  }
  async currentPageSummary(targetName: string): Promise<PageSummary | undefined> {
    const target = this.targetByName(targetName);
    await this.ensureConnected(target);
    const pages = await this.pages(target, { allowEmpty: true });
    if (pages.length === 0) return undefined;
    const page = pages[this.activePageIndex(target.name, pages.length)];
    return {
      id: String(this.activePageIndex(target.name, pages.length)),
      index: this.activePageIndex(target.name, pages.length),
      title: await page.title().catch(() => ""),
      url: safeUrl(page),
      active: true,
    };
  }
  async snapshot(targetName: string): Promise<string> {
    const page = await this.activePage(targetName);
    const title = await page.title().catch(() => "");
    const url = safeUrl(page);
    const body = page.locator("body");
    let semantic = "";
    if (body.ariaSnapshot) {
      semantic = await body.ariaSnapshot({ timeout: 3_000 }).catch(() => "");
    }
    const text = await body.innerText({ timeout: 3_000 }).catch(() => "");
    return [
      `target: ${targetName}`,
      `title: ${title || "(untitled)"}`,
      `url: ${url}`,
      semantic ? `\naria snapshot:\n${semantic}` : "",
      text ? `\nvisible text:\n${text.slice(0, 20_000)}` : "\nvisible text: (empty or unavailable)",
    ].filter(Boolean).join("\n");
  }
  async screenshot(targetName: string, fullPage: boolean): Promise<{ path: string; title: string; url: string; target: string }> {
    const page = await this.activePage(targetName);
    const title = await page.title().catch(() => "");
    const path = await this.artifacts.screenshotPath(title);
    await page.screenshot({ path, fullPage });
    return { path, title, url: safeUrl(page), target: targetName };
  }
  async newPage(targetName: string): Promise<{ id: string; title: string; url: string; target: string }> {
    this.assertCanMutate("newPage");
    const target = this.targetByName(targetName);
    await this.ensureConnected(target);
    const browser = this.browsers.get(target.name);
    const context = browser?.contexts()[0];
    if (!context) throw new Error(`Connected to Chrome target ${target.name}, but no browser context is available`);
    const page = await context.newPage();
    const pages = await this.pages(target, { allowEmpty: true });
    const index = pages.indexOf(page);
    this.activePageIndexes.set(target.name, index >= 0 ? index : Math.max(0, pages.length - 1));
    return { id: String(this.activePageIndex(target.name, pages.length)), title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async navigate(targetName: string, url: string): Promise<{ title: string; url: string; target: string }> {
    this.assertCanMutate("navigate");
    const page = await this.activePage(targetName);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async back(targetName: string): Promise<{ title: string; url: string; target: string }> {
    this.assertCanMutate("back");
    const page = await this.activePage(targetName);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async forward(targetName: string): Promise<{ title: string; url: string; target: string }> {
    this.assertCanMutate("forward");
    const page = await this.activePage(targetName);
    await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async reload(targetName: string): Promise<{ title: string; url: string; target: string }> {
    this.assertCanMutate("reload");
    const page = await this.activePage(targetName);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async wait(targetName: string, params: WaitParams): Promise<{ target: string; waitedFor: string; title: string; url: string }> {
    const page = await this.activePage(targetName);
    const timeout = params.timeout;
    if (params.url) {
      await page.waitForURL(params.url, { timeout });
      return { target: targetName, waitedFor: `url=${params.url}`, title: await page.title().catch(() => ""), url: safeUrl(page) };
    }
    const hasLocator = Boolean(params.role || params.text || params.label || params.placeholder || params.testId || params.selector);
    if (hasLocator) {
      const { locator, target } = locate(page, params);
      await locator.waitFor({ state: params.locatorState ?? "visible", timeout });
      return { target: targetName, waitedFor: `${target} state=${params.locatorState ?? "visible"}`, title: await page.title().catch(() => ""), url: safeUrl(page) };
    }
    const state = params.loadState ?? "load";
    await page.waitForLoadState(state, { timeout });
    return { target: targetName, waitedFor: `loadState=${state}`, title: await page.title().catch(() => ""), url: safeUrl(page) };
  }
  async click(targetName: string, params: LocatorParams): Promise<{ target: string; locator: string; title: string; url: string }> {
    this.assertCanMutate("click");
    const page = await this.activePage(targetName);
    const { locator, target } = locate(page, params);
    await locator.click({ timeout: 10_000 });
    return { target: targetName, locator: target, title: await page.title().catch(() => ""), url: safeUrl(page) };
  }
  async type(targetName: string, params: LocatorParams, value: string, mode: "fill" | "type"): Promise<{ target: string; locator: string; mode: "fill" | "type"; title: string; url: string }> {
    this.assertCanMutate("type");
    const page = await this.activePage(targetName);
    const hasLocator = Boolean(params.role || params.text || params.label || params.placeholder || params.testId || params.selector);
    if (!hasLocator) {
      if (mode === "fill") throw new Error("browser_type mode=fill requires a locator");
      await page.keyboard.type(value);
      return { target: targetName, locator: "focused element", mode, title: await page.title().catch(() => ""), url: safeUrl(page) };
    }
    const { locator, target } = locate(page, params);
    if (mode === "fill") await locator.fill(value, { timeout: 10_000 });
    else await locator.type(value, { timeout: 10_000 });
    return { target: targetName, locator: target, mode, title: await page.title().catch(() => ""), url: safeUrl(page) };
  }
  private async tryConnect(target: BrowserTarget): Promise<boolean> {
    try {
      await this.ensureConnected(target);
      return true;
    } catch {
      return false;
    }
  }
  private async ensureConnected(target: BrowserTarget): Promise<void> {
    if (this.browsers.has(target.name)) return;
    let mod: PlaywrightModule;
    try {
      mod = await import("playwright") as PlaywrightModule;
    } catch (error) {
      throw new Error(`Playwright is not installed for playwright-client extension: ${formatError(error)}`);
    }
    try {
      this.browsers.set(target.name, await mod.chromium.connectOverCDP(target.cdpUrl));
    } catch (error) {
      throw new Error(
        `Unable to connect to Chrome CDP target ${target.name} at ${target.cdpUrl}. ` +
        `Start Chrome with --remote-debugging-port and profile ${this.config.profilePath}. ${formatError(error)}`,
      );
    }
  }
  private async pages(target: BrowserTarget, options?: { allowEmpty?: boolean }): Promise<PageLike[]> {
    await this.ensureConnected(target);
    const browser = this.browsers.get(target.name);
    if (!browser) throw new Error(`Not connected to browser target ${target.name}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (!options?.allowEmpty && pages.length === 0) throw new Error(`Connected to Chrome target ${target.name}, but no pages are open`);
    return pages;
  }
  private async activePage(targetName: string): Promise<PageLike> {
    const target = this.targetByName(targetName);
    const pages = await this.pages(target);
    return pages[this.activePageIndex(target.name, pages.length)];
  }
  private activePageIndex(targetName: string, pageCount: number): number {
    const current = this.activePageIndexes.get(targetName) ?? 0;
    const next = current >= pageCount ? Math.max(0, pageCount - 1) : current;
    this.activePageIndexes.set(targetName, next);
    return next;
  }
  private targetByName(name: string): BrowserTarget {
    const target = this.config.targets.find((candidate) => candidate.name === name);
    if (!target) throw new Error(`No browser target named ${name}. Available targets: ${this.config.targets.map((candidate) => candidate.name).join(", ")}`);
    return target;
  }
  private assertCanMutate(action: string): void {
    if (this.controlState === "human") {
      throw new Error(`browser_${action} refused because browser control state is human; use /browser-resume or browser_control first`);
    }
  }
}
function locate(page: PageLike, params: LocatorParams): { locator: LocatorLike; target: string } {
  const exact = params.exact;
  if (params.role) {
    if (!page.getByRole) throw new Error("Current Playwright page object does not support getByRole");
    return { locator: page.getByRole(params.role, { name: params.name, exact }), target: `role=${params.role}${params.name ? ` name=${params.name}` : ""}` };
  }
  if (params.label) {
    if (!page.getByLabel) throw new Error("Current Playwright page object does not support getByLabel");
    return { locator: page.getByLabel(params.label, { exact }), target: `label=${params.label}` };
  }
  if (params.placeholder) {
    if (!page.getByPlaceholder) throw new Error("Current Playwright page object does not support getByPlaceholder");
    return { locator: page.getByPlaceholder(params.placeholder, { exact }), target: `placeholder=${params.placeholder}` };
  }
  if (params.text) {
    if (!page.getByText) throw new Error("Current Playwright page object does not support getByText");
    return { locator: page.getByText(params.text, { exact }), target: `text=${params.text}` };
  }
  if (params.testId) {
    if (!page.getByTestId) throw new Error("Current Playwright page object does not support getByTestId");
    return { locator: page.getByTestId(params.testId), target: `testId=${params.testId}` };
  }
  if (params.selector) return { locator: page.locator(params.selector), target: `selector=${params.selector}` };
  throw new Error("A locator is required: role/name, text, label, placeholder, testId, or selector");
}
function selectPageSummary(pages: PageSummary[], selection: PageSelectionParams, targetName: string): PageSummary {
  if (selection.pageId) {
    const index = Number(selection.pageId);
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      throw new Error(`No browser page with id ${selection.pageId} for target ${targetName}. Use action=pages to list current pages.`);
    }
    return pages[index];
  }
  const titleNeedle = selection.title?.toLowerCase();
  const urlNeedle = selection.url?.toLowerCase();
  if (!titleNeedle && !urlNeedle) throw new Error("Page selection requires pageId, title, or url");
  const matches = pages.filter((page) => {
    const titleMatches = titleNeedle ? page.title.toLowerCase().includes(titleNeedle) : true;
    const urlMatches = urlNeedle ? page.url.toLowerCase().includes(urlNeedle) : true;
    return titleMatches && urlMatches;
  });
  if (matches.length === 0) {
    throw new Error(`No browser page matched ${formatPageSelection(selection)} for target ${targetName}. Use action=pages to list current pages.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple browser pages matched ${formatPageSelection(selection)} for target ${targetName}: ${matches.map((page) => `${page.id} ${page.title || "(untitled)"}`).join(", ")}. Select by pageId.`);
  }
  return matches[0];
}
function formatPageSelection(selection: PageSelectionParams): string {
  return [
    selection.pageId ? `pageId=${selection.pageId}` : "",
    selection.title ? `title~=${selection.title}` : "",
    selection.url ? `url~=${selection.url}` : "",
  ].filter(Boolean).join(" ");
}
function safeUrl(page: PageLike): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
