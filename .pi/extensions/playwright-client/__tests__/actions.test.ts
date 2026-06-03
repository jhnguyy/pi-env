// @ts-ignore - the extension-level inferred LSP project does not see root devDependencies; root tsc resolves vitest.
import { describe, expect, it, vi } from "vitest";
import { executeBrowserAction, formatActionSummary } from "../actions";

describe("executeBrowserAction", () => {
  it("returns screenshot image content inline", async () => {
    const browser = fakeBrowser({
      screenshot: vi.fn(async () => ({
        target: "local",
        title: "Example",
        url: "https://example.test/",
        path: "/tmp/shot.png",
        data: "iVBORw0KGgo=",
        mimeType: "image/png" as const,
      })),
    });

    const result = await executeBrowserAction(browser, "screenshot", "local", { fullPage: true });

    expect(browser.screenshot).toHaveBeenCalledWith("local", true);
    expect(result.text).toContain("screenshot: /tmp/shot.png");
    expect(result.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
    expect(result.details).toMatchObject({ action: "screenshot", path: "/tmp/shot.png", mimeType: "image/png" });
  });

  it("saves downloads through the browser client", async () => {
    const browser = fakeBrowser({
      download: vi.fn(async () => ({
        target: "local",
        title: "Example",
        url: "https://example.test/",
        locator: "text=Export",
        path: "/tmp/pi-browser-artifacts/downloads/export.csv",
        suggestedFilename: "export.csv",
      })),
    });

    const result = await executeBrowserAction(browser, "download", "local", { text: "Export", timeout: 12_000 });

    expect(browser.download).toHaveBeenCalledWith("local", { text: "Export", timeout: 12_000 });
    expect(result.text).toContain("download: /tmp/pi-browser-artifacts/downloads/export.csv");
    expect(result.details).toMatchObject({ action: "download", locator: "text=Export", path: "/tmp/pi-browser-artifacts/downloads/export.csv", suggestedFilename: "export.csv" });
  });
});

describe("formatActionSummary", () => {
  it("summarizes download locators", () => {
    expect(formatActionSummary("download", { text: "Export" })).toBe("text=Export");
  });
});

function fakeBrowser(overrides: Record<string, unknown>) {
  return {
    cleanupAfterError: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}
