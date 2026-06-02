// @ts-ignore - the extension-level inferred LSP project does not see root devDependencies; root tsc resolves vitest.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserClient, isConnectionBrokenError } from "../browser";
import { loadBrowserClientConfig } from "../config";

const mockState = vi.hoisted(() => ({
  browsers: [] as FakeBrowser[],
  connectOverCDP: vi.fn(),
}));

type DisconnectHandler = () => void;
type FakeBrowser = {
  connected: boolean;
  closeCalls: number;
  disconnectHandler?: DisconnectHandler;
  contexts: () => Array<{ pages: () => FakePage[] }>;
  close: () => Promise<void>;
  isConnected: () => boolean;
  on: (event: "disconnected", handler: DisconnectHandler) => void;
};
type FakePage = {
  title: () => Promise<string>;
  url: () => string;
  locator: () => { innerText: () => Promise<string>; ariaSnapshot: () => Promise<string> };
};

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: mockState.connectOverCDP,
  },
}));

beforeEach(() => {
  mockState.browsers.splice(0);
  mockState.connectOverCDP.mockReset();
  mockState.connectOverCDP.mockImplementation(async () => {
    const browser = fakeBrowser();
    mockState.browsers.push(browser);
    return browser;
  });
});

describe("BrowserClient connection cleanup", () => {
  it("evicts unhealthy cached connections and reconnects on the next use", async () => {
    const client = new BrowserClient(loadBrowserClientConfig());

    await client.status("local");
    expect(mockState.connectOverCDP).toHaveBeenCalledTimes(1);

    mockState.browsers[0].connected = false;
    await client.status("local");

    expect(mockState.browsers[0].closeCalls).toBe(1);
    expect(mockState.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(client.getHistory(1)[0]).toMatchObject({
      action: "cleanup",
      target: "local",
      result: expect.stringContaining("evicted stale browser connection"),
    });
  });

  it("evicts when Playwright reports browser disconnection", async () => {
    const client = new BrowserClient(loadBrowserClientConfig());

    await client.listPages("local");
    expect(mockState.connectOverCDP).toHaveBeenCalledTimes(1);

    mockState.browsers[0].disconnectHandler?.();
    await vi.waitFor(() => expect(mockState.browsers[0].closeCalls).toBe(1));

    await client.listPages("local");
    expect(mockState.connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("allows tool execution to drop cached connections after connection-level errors", async () => {
    const client = new BrowserClient(loadBrowserClientConfig());

    await client.listPages("local");
    await client.cleanupAfterError("local", new Error("Target closed"));
    await client.listPages("local");

    expect(mockState.browsers[0].closeCalls).toBe(1);
    expect(mockState.connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("does not classify ordinary locator timeouts as broken connections", () => {
    expect(isConnectionBrokenError(new Error("Timeout 10000ms exceeded while waiting for locator"))).toBe(false);
  });
});

function fakeBrowser(): FakeBrowser {
  const page = fakePage();
  const browser: FakeBrowser = {
    connected: true,
    closeCalls: 0,
    contexts: () => {
      if (!browser.connected) throw new Error("Browser has been closed");
      return [{ pages: () => [page] }];
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

function fakePage(): FakePage {
  return {
    title: async () => "Test Page",
    url: () => "https://example.test/",
    locator: () => ({
      innerText: async () => "body text",
      ariaSnapshot: async () => "snapshot",
    }),
  };
}
