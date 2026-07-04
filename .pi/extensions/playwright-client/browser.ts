import type { BrowserClientConfig, BrowserTarget } from "./config";
import { BrowserArtifacts } from "./artifacts";

import type { DownloadLike, LocatorParams, PageLike, WaitParams } from "./locators";
import { downloadTrigger, hasLocatorParams, LoadState, LocatorWaitState, locate } from "./locators";
export type { LocatorParams, WaitParams } from "./locators";

type BrowserLike = {
  contexts(): ContextLike[];
  close(): Promise<void>;
  isConnected?(): boolean;
  on?(event: "disconnected", handler: () => void): void;
};
type ContextLike = {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
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
export interface PageSelectionParams {
  pageId?: string;
  title?: string;
  url?: string;
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
interface BrowserConnection {
  browser: BrowserLike;
  connectedAt: number;
  lastUsedAt: number;
  failures: number;
  lastFailureAt?: number;
}
const HISTORY_LIMIT = 50;
const CONNECTION_MAX_IDLE_MS = 10 * 60 * 1_000;

export class BrowserClient {
  private readonly connections = new Map<string, BrowserConnection>();
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
    await this.cleanupStaleConnections();
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
    await this.cleanupStaleConnections();
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
  async screenshot(targetName: string, fullPage: boolean): Promise<{ path: string; data: string; mimeType: "image/png"; title: string; url: string; target: string }> {
    const page = await this.activePage(targetName);
    const title = await page.title().catch(() => "");
    const path = await this.artifacts.screenshotPath(title);
    const bytes = await page.screenshot({ path, fullPage });
    const data = Buffer.from(bytes).toString("base64");
    return { path, data, mimeType: "image/png", title, url: safeUrl(page), target: targetName };
  }
  async newPage(targetName: string): Promise<{ id: string; title: string; url: string; target: string }> {
    this.assertCanMutate("newPage");
    const target = this.targetByName(targetName);
    await this.ensureConnected(target);
    const browser = this.connections.get(target.name)?.browser;
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
    await page.goto(url, { waitUntil: LoadState.DomContentLoaded, timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async back(targetName: string): Promise<{ title: string; url: string; target: string }> {
    this.assertCanMutate("back");
    const page = await this.activePage(targetName);
    await page.goBack({ waitUntil: LoadState.DomContentLoaded, timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async forward(targetName: string): Promise<{ title: string; url: string; target: string }> {
    this.assertCanMutate("forward");
    const page = await this.activePage(targetName);
    await page.goForward({ waitUntil: LoadState.DomContentLoaded, timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async reload(targetName: string): Promise<{ title: string; url: string; target: string }> {
    this.assertCanMutate("reload");
    const page = await this.activePage(targetName);
    await page.reload({ waitUntil: LoadState.DomContentLoaded, timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page), target: targetName };
  }
  async wait(targetName: string, params: WaitParams): Promise<{ target: string; waitedFor: string; title: string; url: string }> {
    const page = await this.activePage(targetName);
    const timeout = params.timeout;
    if (params.url) {
      await page.waitForURL(params.url, { timeout });
      return { target: targetName, waitedFor: `url=${params.url}`, title: await page.title().catch(() => ""), url: safeUrl(page) };
    }
    if (hasLocatorParams(params)) {
      const { locator, target } = locate(page, params);
      await locator.waitFor({ state: params.locatorState ?? LocatorWaitState.Visible, timeout });
      return { target: targetName, waitedFor: `${target} state=${params.locatorState ?? LocatorWaitState.Visible}`, title: await page.title().catch(() => ""), url: safeUrl(page) };
    }
    const state = params.loadState ?? LoadState.Load;
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
  async download(targetName: string, params: LocatorParams & { timeout?: number; url?: string }): Promise<{ target: string; locator: string; path: string; suggestedFilename: string; title: string; url: string }> {
    const page = await this.activePage(targetName);
    const timeout = params.timeout ?? 30_000;
    const trigger = downloadTrigger(page, params);
    if (trigger.kind !== "wait") this.assertCanMutate("download");
    const downloadPromise = page.waitForEvent("download", { timeout });
    let download: DownloadLike;
    try {
      await trigger.run();
      download = await downloadPromise;
    } catch (error) {
      downloadPromise.catch(() => undefined);
      throw error;
    }
    const failure = await download.failure();
    if (failure) throw new Error(`Browser download failed: ${failure}`);
    const suggestedFilename = download.suggestedFilename();
    const path = await this.artifacts.downloadPath(suggestedFilename);
    await download.saveAs(path);
    return { target: targetName, locator: trigger.label, path, suggestedFilename, title: await page.title().catch(() => ""), url: safeUrl(page) };
  }
  async type(targetName: string, params: LocatorParams, value: string, mode: "fill" | "type"): Promise<{ target: string; locator: string; mode: "fill" | "type"; title: string; url: string }> {
    this.assertCanMutate("type");
    const page = await this.activePage(targetName);
    if (!hasLocatorParams(params)) {
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
    const existing = this.connections.get(target.name);
    if (existing) {
      if (this.isConnectionHealthy(existing.browser)) {
        existing.lastUsedAt = Date.now();
        return;
      }
      await this.evictConnection(target.name, "cached connection is no longer healthy");
    }
    let mod: PlaywrightModule;
    try {
      // @ts-ignore - the extension-level inferred LSP project does not see root dependencies; root tsc resolves playwright.
      mod = await import("playwright") as PlaywrightModule;
    } catch (error) {
      throw new Error(`Playwright is not installed for playwright-client extension: ${formatError(error)}`);
    }
    try {
      const browser = await mod.chromium.connectOverCDP(target.cdpUrl);
      browser.on?.("disconnected", () => {
        void this.evictConnection(target.name, "browser disconnected");
      });
      this.connections.set(target.name, {
        browser,
        connectedAt: Date.now(),
        lastUsedAt: Date.now(),
        failures: 0,
      });
    } catch (error) {
      throw new Error(
        `Unable to connect to Chrome CDP target ${target.name} at ${target.cdpUrl}. ` +
        `Start Chrome with --remote-debugging-port and profile ${this.config.profilePath}. ${formatError(error)}`,
      );
    }
  }
  private async pages(target: BrowserTarget, options?: { allowEmpty?: boolean }): Promise<PageLike[]> {
    await this.ensureConnected(target);
    const browser = this.connections.get(target.name)?.browser;
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
  async cleanupAfterError(targetName: string | undefined, error: unknown): Promise<void> {
    if (!targetName || !isConnectionBrokenError(error)) return;
    const connection = this.connections.get(targetName);
    if (connection) {
      connection.failures += 1;
      connection.lastFailureAt = Date.now();
    }
    await this.evictConnection(targetName, formatError(error));
  }
  private async cleanupStaleConnections(): Promise<void> {
    const now = Date.now();
    for (const [targetName, connection] of this.connections) {
      if (!this.isConnectionHealthy(connection.browser)) {
        await this.evictConnection(targetName, "connection failed health check");
      } else if (now - connection.lastUsedAt > CONNECTION_MAX_IDLE_MS) {
        await this.evictConnection(targetName, `idle for ${now - connection.lastUsedAt}ms`);
      }
    }
  }
  private isConnectionHealthy(browser: BrowserLike): boolean {
    if (browser.isConnected && !browser.isConnected()) return false;
    try {
      browser.contexts();
      return true;
    } catch {
      return false;
    }
  }
  private async evictConnection(targetName: string, reason: string): Promise<void> {
    const connection = this.connections.get(targetName);
    this.connections.delete(targetName);
    this.activePageIndexes.delete(targetName);
    if (!connection) return;
    await connection.browser.close().catch(() => undefined);
    this.recordHistory({ action: "cleanup", target: targetName, result: `evicted stale browser connection: ${reason}` });
  }
  private assertCanMutate(action: string): void {
    if (this.controlState === "human") {
      throw new Error(`browser_${action} refused because browser control state is human; use /browser-resume or browser_control first`);
    }
  }
}
export function isConnectionBrokenError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return [
    "target closed",
    "browser has been closed",
    "browser context closed",
    "page closed",
    "connection closed",
    "websocket",
    "econnreset",
    "econnrefused",
    "cdp",
  ].some((needle) => message.includes(needle));
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
