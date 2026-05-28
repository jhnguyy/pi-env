import type { BrowserClientConfig, BrowserTarget } from "./config";
import { BrowserArtifacts } from "./artifacts";

type BrowserLike = {
  contexts(): Array<{ pages(): PageLike[] }>;
  close(): Promise<void>;
};
type LocatorLike = {
  click(options?: { timeout?: number }): Promise<unknown>;
  fill(value: string, options?: { timeout?: number }): Promise<unknown>;
  type(value: string, options?: { timeout?: number }): Promise<unknown>;
  innerText(options?: { timeout?: number }): Promise<string>;
  ariaSnapshot?(options?: { timeout?: number }): Promise<string>;
};
type PageLike = {
  title(): Promise<string>;
  url(): string;
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }): Promise<unknown>;
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
export class BrowserClient {
  private browser?: BrowserLike;
  private activePageIndex = 0;
  private controlState: ControlState = "agent";
  private readonly artifacts: BrowserArtifacts;
  private cdpUrl: string;
  private targetName: string;
  constructor(private readonly config: BrowserClientConfig) {
    this.artifacts = new BrowserArtifacts(config.artifactDir);
    this.cdpUrl = config.cdpUrl;
    this.targetName = config.targetName;
  }
  setControlState(state: ControlState): void {
    this.controlState = state;
  }
  getControlState(): ControlState {
    return this.controlState;
  }
  listTargets(): Array<BrowserTarget & { active: boolean }> {
    return this.config.targets.map((target) => ({ ...target, active: target.name === this.targetName }));
  }
  async selectTarget(name: string): Promise<BrowserTarget> {
    const target = this.config.targets.find((candidate) => candidate.name === name);
    if (!target) throw new Error(`No browser target named ${name}. Available targets: ${this.config.targets.map((candidate) => candidate.name).join(", ")}`);
    await this.disconnect();
    this.targetName = target.name;
    this.cdpUrl = target.cdpUrl;
    this.activePageIndex = 0;
    return target;
  }
  async status(): Promise<string> {
    const connected = await this.tryConnect();
    const pages = connected ? await this.listPages() : [];
    const active = pages.find((page) => page.active);
    return [
      `backend: chrome-cdp`,
      `connected: ${connected ? "yes" : "no"}`,
      `target: ${this.targetName}`,
      `cdpUrl: ${this.cdpUrl}`,
      `targets: ${this.config.targets.map((target) => target.name).join(", ")}`,
      `profile: ${this.config.profileName}`,
      `profilePath: ${this.config.profilePath}`,
      `artifactDir: ${this.config.artifactDir}`,
      `controlState: ${this.controlState}`,
      `pages: ${pages.length}`,
      active ? `activePage: ${active.id} ${active.title || "(untitled)"} — ${active.url}` : `activePage: none`,
    ].join("\n");
  }
  async listPages(): Promise<PageSummary[]> {
    await this.ensureConnected();
    const pages = await this.pages();
    if (this.activePageIndex >= pages.length) this.activePageIndex = Math.max(0, pages.length - 1);
    return Promise.all(pages.map(async (page, index) => ({
      id: String(index),
      index,
      title: await page.title().catch(() => ""),
      url: safeUrl(page),
      active: index === this.activePageIndex,
    })));
  }
  async selectPage(id: string): Promise<PageSummary> {
    const pages = await this.listPages();
    const index = Number(id);
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      throw new Error(`No browser page with id ${id}`);
    }
    this.activePageIndex = index;
    return (await this.listPages())[index];
  }
  async snapshot(): Promise<string> {
    const page = await this.activePage();
    const title = await page.title().catch(() => "");
    const url = safeUrl(page);
    const body = page.locator("body");
    let semantic = "";
    if (body.ariaSnapshot) {
      semantic = await body.ariaSnapshot({ timeout: 3_000 }).catch(() => "");
    }
    const text = await body.innerText({ timeout: 3_000 }).catch(() => "");
    return [
      `title: ${title || "(untitled)"}`,
      `url: ${url}`,
      semantic ? `\naria snapshot:\n${semantic}` : "",
      text ? `\nvisible text:\n${text.slice(0, 20_000)}` : "\nvisible text: (empty or unavailable)",
    ].filter(Boolean).join("\n");
  }
  async screenshot(fullPage: boolean): Promise<{ path: string; title: string; url: string }> {
    const page = await this.activePage();
    const title = await page.title().catch(() => "");
    const path = await this.artifacts.screenshotPath(title);
    await page.screenshot({ path, fullPage });
    return { path, title, url: safeUrl(page) };
  }
  async navigate(url: string): Promise<{ title: string; url: string }> {
    this.assertCanMutate("navigate");
    const page = await this.activePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { title: await page.title().catch(() => ""), url: safeUrl(page) };
  }
  async click(params: LocatorParams): Promise<{ target: string; title: string; url: string }> {
    this.assertCanMutate("click");
    const page = await this.activePage();
    const { locator, target } = locate(page, params);
    await locator.click({ timeout: 10_000 });
    return { target, title: await page.title().catch(() => ""), url: safeUrl(page) };
  }
  async type(params: LocatorParams, value: string, mode: "fill" | "type"): Promise<{ target: string; mode: "fill" | "type"; title: string; url: string }> {
    this.assertCanMutate("type");
    const page = await this.activePage();
    const hasLocator = Boolean(params.role || params.text || params.label || params.placeholder || params.testId || params.selector);
    if (!hasLocator) {
      if (mode === "fill") throw new Error("browser_type mode=fill requires a locator");
      await page.keyboard.type(value);
      return { target: "focused element", mode, title: await page.title().catch(() => ""), url: safeUrl(page) };
    }
    const { locator, target } = locate(page, params);
    if (mode === "fill") await locator.fill(value, { timeout: 10_000 });
    else await locator.type(value, { timeout: 10_000 });
    return { target, mode, title: await page.title().catch(() => ""), url: safeUrl(page) };
  }
  private async tryConnect(): Promise<boolean> {
    try {
      await this.ensureConnected();
      return true;
    } catch {
      return false;
    }
  }
  private async ensureConnected(): Promise<void> {
    if (this.browser) return;
    let mod: PlaywrightModule;
    try {
      mod = await import("playwright") as PlaywrightModule;
    } catch (error) {
      throw new Error(`Playwright is not installed for playwright-client extension: ${formatError(error)}`);
    }
    try {
      this.browser = await mod.chromium.connectOverCDP(this.cdpUrl);
    } catch (error) {
      throw new Error(
        `Unable to connect to Chrome CDP target ${this.targetName} at ${this.cdpUrl}. ` +
        `Start Chrome with --remote-debugging-port and profile ${this.config.profilePath}. ${formatError(error)}`,
      );
    }
  }
  private async disconnect(): Promise<void> {
    if (!this.browser) return;
    const browser = this.browser;
    this.browser = undefined;
    await browser.close().catch(() => undefined);
  }
  private async pages(): Promise<PageLike[]> {
    await this.ensureConnected();
    const pages = this.browser!.contexts().flatMap((context) => context.pages());
    if (pages.length === 0) throw new Error("Connected to Chrome, but no pages are open");
    return pages;
  }
  private async activePage(): Promise<PageLike> {
    const pages = await this.pages();
    if (this.activePageIndex >= pages.length) this.activePageIndex = Math.max(0, pages.length - 1);
    return pages[this.activePageIndex];
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
