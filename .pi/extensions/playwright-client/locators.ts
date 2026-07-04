export enum LocatorWaitState {
  Attached = "attached",
  Detached = "detached",
  Visible = "visible",
  Hidden = "hidden",
}

export enum LoadState {
  DomContentLoaded = "domcontentloaded",
  Load = "load",
  NetworkIdle = "networkidle",
}

export type LocatorLike = {
  click(options?: { timeout?: number }): Promise<unknown>;
  fill(value: string, options?: { timeout?: number }): Promise<unknown>;
  type(value: string, options?: { timeout?: number }): Promise<unknown>;
  waitFor(options?: { state?: LocatorWaitState; timeout?: number }): Promise<unknown>;
  innerText(options?: { timeout?: number }): Promise<string>;
  ariaSnapshot?(options?: { timeout?: number }): Promise<string>;
};

export type DownloadLike = {
  suggestedFilename(): string;
  saveAs(path: string): Promise<unknown>;
  failure(): Promise<string | null>;
};

export type PageLike = {
  title(): Promise<string>;
  url(): string;
  goto(url: string, options?: { waitUntil?: LoadState.DomContentLoaded | LoadState.Load; timeout?: number }): Promise<unknown>;
  goBack(options?: { waitUntil?: LoadState; timeout?: number }): Promise<unknown>;
  goForward(options?: { waitUntil?: LoadState; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: LoadState; timeout?: number }): Promise<unknown>;
  waitForLoadState(state?: LoadState, options?: { timeout?: number }): Promise<unknown>;
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<unknown>;
  waitForEvent(event: "download", options?: { timeout?: number }): Promise<DownloadLike>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Uint8Array>;
  locator(selector: string): LocatorLike;
  getByRole?(role: string, options?: { name?: string; exact?: boolean }): LocatorLike;
  getByText?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByLabel?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByPlaceholder?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByTestId?(testId: string): LocatorLike;
  keyboard: { type(value: string): Promise<unknown> };
};

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

export interface WaitParams extends LocatorParams {
  url?: string;
  loadState?: LoadState;
  locatorState?: LocatorWaitState;
  timeout?: number;
}

export function hasLocatorParams(params: LocatorParams): boolean {
  return Boolean(params.role || params.text || params.label || params.placeholder || params.testId || params.selector);
}

export function downloadTrigger(page: PageLike, params: LocatorParams & { url?: string }): { kind: "click" | "navigate" | "wait"; label: string; run(): Promise<unknown> } {
  if (hasLocatorParams(params)) {
    const { locator, target } = locate(page, params);
    return { kind: "click", label: target, run: () => locator.click({ timeout: 10_000 }) };
  }
  if (params.url) {
    return { kind: "navigate", label: `url=${params.url}`, run: () => page.goto(params.url!, { waitUntil: LoadState.DomContentLoaded, timeout: 30_000 }) };
  }
  return { kind: "wait", label: "next download", run: async () => undefined };
}

export function locate(page: PageLike, params: LocatorParams): { locator: LocatorLike; target: string } {
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
