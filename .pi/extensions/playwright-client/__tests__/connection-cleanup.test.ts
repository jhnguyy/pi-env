// @ts-ignore - the extension-level inferred LSP project does not see root devDependencies; root tsc resolves vitest.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserClient,
  isConnectionBrokenError,
  type BrowserLike,
  type PlaywrightLoader,
} from "../browser";
import type { BrowserClientConfig } from "../config";
import type { LocatorLike, PageLike } from "../locators";

type DisconnectHandler = () => void;
type FakeBrowser = BrowserLike & {
  connected: boolean;
  closeCalls: number;
  disconnectHandler?: DisconnectHandler;
};

const browsers: FakeBrowser[] = [];
const connectOverCDP = vi.fn(async () => {
  const browser = fakeBrowser(`Page ${browsers.length + 1}`);
  browsers.push(browser);
  return browser;
});
const loadPlaywright: PlaywrightLoader = async () => ({ chromium: { connectOverCDP } });

beforeEach(() => {
  browsers.splice(0);
  connectOverCDP.mockClear();
});

describe("BrowserClient connection cleanup", () => {
  it("evicts unhealthy cached connections and reconnects on the next use", async () => {
    const client = new BrowserClient(config(), loadPlaywright);

    await client.status("local");
    expect(connectOverCDP).toHaveBeenCalledTimes(1);

    browsers[0].connected = false;
    expect(await client.status("local")).toContain("activePage: 0 Page 2 — https://example.test/");

    expect(browsers[0].closeCalls).toBe(1);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(client.getHistory(1)[0]).toMatchObject({
      action: "cleanup",
      target: "local",
      result: expect.stringContaining("evicted stale browser connection"),
    });
  });

  it("evicts when Playwright reports browser disconnection", async () => {
    const client = new BrowserClient(config(), loadPlaywright);

    await client.listPages("local");
    expect(connectOverCDP).toHaveBeenCalledTimes(1);

    browsers[0].disconnectHandler?.();
    await vi.waitFor(() => expect(browsers[0].closeCalls).toBe(1));

    expect(await client.listPages("local")).toEqual([
      { id: "0", index: 0, title: "Page 2", url: "https://example.test/", active: true },
    ]);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("allows tool execution to drop cached connections after connection-level errors", async () => {
    const client = new BrowserClient(config(), loadPlaywright);

    await client.listPages("local");
    await client.cleanupAfterError("local", new Error("Target closed"));
    expect(await client.listPages("local")).toEqual([
      { id: "0", index: 0, title: "Page 2", url: "https://example.test/", active: true },
    ]);

    expect(browsers[0].closeCalls).toBe(1);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("does not classify ordinary locator timeouts as broken connections", () => {
    expect(
      isConnectionBrokenError(new Error("Timeout 10000ms exceeded while waiting for locator")),
    ).toBe(false);
  });
});

function config(): BrowserClientConfig {
  return {
    artifactDir: "/unused",
    profileName: "test",
    profilePath: "/unused",
    targets: [{ name: "local", host: "127.0.0.1", port: 9222, protocol: "http", path: "", cdpUrl: "http://127.0.0.1:9222" }],
  };
}

function fakeBrowser(title: string): FakeBrowser {
  const page = fakePage(title);
  const browser: FakeBrowser = {
    connected: true,
    closeCalls: 0,
    contexts: () => {
      if (!browser.connected) throw new Error("Browser has been closed");
      return [{ pages: () => [page], newPage: async () => page }];
    },
    close: async () => {
      browser.closeCalls += 1;
      browser.connected = false;
    },
    isConnected: () => browser.connected,
    on: (_event, handler) => {
      browser.disconnectHandler = handler;
    },
  };
  return browser;
}

function fakePage(title: string): PageLike {
  const locator: LocatorLike = {
    click: async () => undefined,
    fill: async () => undefined,
    type: async () => undefined,
    waitFor: async () => undefined,
    innerText: async () => "body text",
    ariaSnapshot: async () => "snapshot",
  };
  return {
    title: async () => title,
    url: () => "https://example.test/",
    goto: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    reload: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForURL: async () => undefined,
    waitForEvent: async () => {
      throw new Error("No download expected");
    },
    screenshot: async () => new Uint8Array(),
    locator: () => locator,
    keyboard: { type: async () => undefined },
  };
}
