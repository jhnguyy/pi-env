import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore - the extension-level inferred LSP project does not see root devDependencies; root tsc resolves vitest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserClient, type BrowserLike, type PlaywrightLoader } from "../browser";
import type { BrowserClientConfig } from "../config";
import type { LocatorLike, PageLike } from "../locators";

describe("BrowserClient downloads", () => {
  let artifactDir: string;
  let page: FakePage;
  let connectOverCDP: ReturnType<typeof vi.fn<(endpointURL: string) => Promise<BrowserLike>>>;
  let loadPlaywright: PlaywrightLoader;

  beforeEach(async () => {
    artifactDir = await mkdtemp(join(tmpdir(), "pi-browser-test-"));
    page = fakePage();
    connectOverCDP = vi.fn(async () => fakeBrowser(page));
    loadPlaywright = async () => ({ chromium: { connectOverCDP } });
  });

  afterEach(async () => {
    await rm(artifactDir, { recursive: true, force: true });
  });

  it("clicks a locator, waits for a download, and saves it under the artifact dir", async () => {
    const client = new BrowserClient(config(artifactDir), loadPlaywright);

    const result = await client.download("local", { text: "Export" });

    expect(page.downloadRequested).toBe(true);
    expect(result.suggestedFilename).toBe("report.csv");
    expect(result.path).toContain(join(artifactDir, "downloads"));
    expect(result.path).toMatch(/report\.csv$/);
    await expect(readFile(result.path, "utf8")).resolves.toBe("a,b\n1,2\n");
  });
});

function config(artifactDir: string): BrowserClientConfig {
  return {
    artifactDir,
    profileName: "test-profile",
    profilePath: "/tmp/test-profile",
    targets: [
      {
        name: "local",
        host: "127.0.0.1",
        port: 9222,
        protocol: "http",
        path: "",
        cdpUrl: "http://127.0.0.1:9222",
      },
    ],
  };
}

type FakePage = PageLike & { downloadRequested: boolean };

function fakeBrowser(page: PageLike): BrowserLike {
  return {
    contexts: () => [{ pages: () => [page], newPage: async () => page }],
    close: async () => undefined,
    isConnected: () => true,
    on: () => undefined,
  };
}

function fakePage(): FakePage {
  const passiveLocator: LocatorLike = {
    click: async () => undefined,
    fill: async () => undefined,
    type: async () => undefined,
    waitFor: async () => undefined,
    innerText: async () => "",
    ariaSnapshot: async () => "",
  };
  const page: FakePage = {
    downloadRequested: false,
    title: async () => "Reports",
    url: () => "https://example.test/reports",
    goto: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    reload: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForURL: async () => undefined,
    waitForEvent: async (event) => {
      expect(event).toBe("download");
      return {
        suggestedFilename: () => "report.csv",
        failure: async () => null,
        saveAs: async (path) => writeFile(path, "a,b\n1,2\n"),
      };
    },
    screenshot: async () => new Uint8Array(),
    locator: (selector) => ({
      ...passiveLocator,
      click: async () => expect(selector).toBe("body"),
    }),
    getByText: (text) => ({
      ...passiveLocator,
      click: async () => {
        expect(text).toBe("Export");
        page.downloadRequested = true;
      },
    }),
    keyboard: { type: async () => undefined },
  };
  return page;
}
