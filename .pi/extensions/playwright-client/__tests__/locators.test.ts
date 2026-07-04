// @ts-ignore - the extension-level inferred LSP project does not see root devDependencies; root tsc resolves vitest.
import { describe, expect, it, vi } from "vitest";
import { downloadTrigger, hasLocatorParams, locate } from "../locators";
import type { PageLike } from "../locators";

describe("browser locator helpers", () => {
  it("detects locator-shaped parameters", () => {
    expect(hasLocatorParams({})).toBe(false);
    expect(hasLocatorParams({ text: "Export" })).toBe(true);
    expect(hasLocatorParams({ selector: "button.primary" })).toBe(true);
  });

  it("prefers accessible role locators and formats the target", () => {
    const roleLocator = fakeLocator();
    const page = fakePage({ getByRole: vi.fn(() => roleLocator) });

    const result = locate(page, { role: "button", name: "Save", exact: true });

    expect(result).toEqual({ locator: roleLocator, target: "role=button name=Save" });
    expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Save", exact: true });
  });

  it("falls back to CSS selectors when no semantic locator is provided", () => {
    const selectorLocator = fakeLocator();
    const page = fakePage({ locator: vi.fn(() => selectorLocator) });

    const result = locate(page, { selector: "[data-testid=save]" });

    expect(result).toEqual({ locator: selectorLocator, target: "selector=[data-testid=save]" });
    expect(page.locator).toHaveBeenCalledWith("[data-testid=save]");
  });

  it("builds a click download trigger when a locator is present", async () => {
    const textLocator = fakeLocator();
    const page = fakePage({ getByText: vi.fn(() => textLocator) });

    const trigger = downloadTrigger(page, { text: "Export" });
    await trigger.run();

    expect(trigger.kind).toBe("click");
    expect(trigger.label).toBe("text=Export");
    expect(textLocator.click).toHaveBeenCalledWith({ timeout: 10_000 });
  });

  it("builds a navigation trigger when only a URL is present", async () => {
    const page = fakePage();

    const trigger = downloadTrigger(page, { url: "https://example.test/export.csv" });
    await trigger.run();

    expect(trigger.kind).toBe("navigate");
    expect(trigger.label).toBe("url=https://example.test/export.csv");
    expect(page.goto).toHaveBeenCalledWith("https://example.test/export.csv", { waitUntil: "domcontentloaded", timeout: 30_000 });
  });
});

function fakeLocator() {
  return {
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
    innerText: vi.fn(async () => ""),
  };
}

function fakePage(overrides: Partial<PageLike> = {}): PageLike {
  return {
    title: vi.fn(async () => ""),
    url: vi.fn(() => ""),
    goto: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    waitForURL: vi.fn(async () => undefined),
    waitForEvent: vi.fn(async () => ({
      suggestedFilename: () => "download.txt",
      saveAs: async () => undefined,
      failure: async () => null,
    })),
    screenshot: vi.fn(async () => new Uint8Array()),
    locator: vi.fn(() => fakeLocator()),
    keyboard: { type: vi.fn(async () => undefined) },
    ...overrides,
  };
}
