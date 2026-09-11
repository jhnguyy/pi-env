// @ts-ignore - the extension-level inferred LSP project does not see root devDependencies; root tsc resolves vitest.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserClient,
  isConnectionBrokenError,
  type BrowserLike,
  type PlaywrightLoader,
} from "../browser";
import { loadBrowserClientConfig } from "../config";
import type { LocatorLike, PageLike } from "../locators";

type DisconnectHandler = () => void;
type FakeBrowser = BrowserLike & {
  connected: boolean;
  closeCalls: number;
  disconnectHandler?: DisconnectHandler;
};

const browsers: FakeBrowser[] = [];
const connectOverCDP = vi.fn(async () => {
  const browser = fakeBrowser();
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
    const client = new BrowserClient(loadBrowserClientConfig(), loadPlaywright);

    await client.status("local");
    expect(connectOverCDP).toHaveBeenCalledTimes(1);

    browsers[0].connected = false;
    await client.status("local");

    expect(browsers[0].closeCalls).toBe(1);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(client.getHistory(1)[0]).toMatchObject({
      action: "cleanup",
      target: "local",
      result: expect.stringContaining("evicted stale browser connection"),
    });
  });

  it("evicts when Playwright reports browser disconnection", async () => {
    const client = new BrowserClient(loadBrowserClientConfig(), loadPlaywright);

    await client.listPages("local");
    expect(connectOverCDP).toHaveBeenCalledTimes(1);

    browsers[0].disconnectHandler?.();
    await vi.waitFor(() => expect(browsers[0].closeCalls).toBe(1));

    await client.listPages("local");
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("allows tool execution to drop cached connections after connection-level errors", async () => {
    const client = new BrowserClient(loadBrowserClientConfig(), loadPlaywright);

    await client.listPages("local");
    await client.cleanupAfterError("local", new Error("Target closed"));
    await client.listPages("local");

    expect(browsers[0].closeCalls).toBe(1);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("does not classify ordinary locator timeouts as broken connections", () => {
    expect(
      isConnectionBrokenError(new Error("Timeout 10000ms exceeded while waiting for locator")),
    ).toBe(false);
  });
});

function fakeBrowser(): FakeBrowser {
  const page = fakePage();
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

function fakePage(): PageLike {
  const locator: LocatorLike = {
    click: async () => undefined,
    fill: async () => undefined,
    type: async () => undefined,
    waitFor: async () => undefined,
    innerText: async () => "body text",
    ariaSnapshot: async () => "snapshot",
  };
  return {
    title: async () => "Test Page",
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
