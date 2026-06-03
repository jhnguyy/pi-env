import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore - the extension-level inferred LSP project does not see root devDependencies; root tsc resolves vitest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserClient } from "../browser";
import type { BrowserClientConfig } from "../config";

const mockState = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  page: undefined as FakePage | undefined,
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: mockState.connectOverCDP,
  },
}));

describe("BrowserClient downloads", () => {
  let artifactDir: string;

  beforeEach(async () => {
    artifactDir = await mkdtemp(join(tmpdir(), "pi-browser-test-"));
    mockState.page = fakePage();
    mockState.connectOverCDP.mockReset();
    mockState.connectOverCDP.mockResolvedValue(fakeBrowser(mockState.page));
  });

  afterEach(async () => {
    await rm(artifactDir, { recursive: true, force: true });
  });

  it("clicks a locator, waits for a download, and saves it under the artifact dir", async () => {
    const client = new BrowserClient(config(artifactDir));

    const result = await client.download("local", { text: "Export" });

    expect(mockState.page?.downloadRequested).toBe(true);
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
    targets: [{ name: "local", host: "127.0.0.1", port: 9222, protocol: "http", path: "", cdpUrl: "http://127.0.0.1:9222" }],
  };
}

type FakePage = ReturnType<typeof fakePage>;

function fakeBrowser(page: FakePage) {
  return {
    contexts: () => [{ pages: () => [page] }],
    close: async () => undefined,
    isConnected: () => true,
    on: vi.fn(),
  };
}

function fakePage() {
  const page = {
    downloadRequested: false,
    title: async () => "Reports",
    url: () => "https://example.test/reports",
    waitForEvent: vi.fn(async (event: "download") => {
      expect(event).toBe("download");
      return {
        suggestedFilename: () => "report.csv",
        failure: async () => null,
        saveAs: async (path: string) => {
          await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "a,b\n1,2\n"));
        },
      };
    }),
    locator: vi.fn((selector: string) => ({
      click: async () => {
        expect(selector).toBe("body");
      },
      innerText: async () => "",
      ariaSnapshot: async () => "",
    })),
    getByText: vi.fn((text: string) => ({
      click: async () => {
        expect(text).toBe("Export");
        page.downloadRequested = true;
      },
      fill: async () => undefined,
      type: async () => undefined,
      waitFor: async () => undefined,
      innerText: async () => "",
    })),
  };
  return page;
}
