import { afterEach, describe, expect, it } from "vitest";
import { BrowserClient } from "../browser";
import { loadBrowserClientConfig } from "../config";

const ENV_KEYS = [
  "PI_BROWSER_PROFILE",
  "PI_BROWSER_PROFILE_PATH",
  "PI_BROWSER_ARTIFACT_DIR",
  "PI_BROWSER_CDP_URL",
  "PI_BROWSER_CDP_HOST",
  "PI_BROWSER_CDP_PORT",
  "PI_BROWSER_TARGET",
  "PI_BROWSER_TARGETS",
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("playwright-client config", () => {
  it("defaults to local CDP target for SSH reverse-forward use", () => {
    clearBrowserEnv();

    const config = loadBrowserClientConfig();

    expect(config.targetName).toBe("local");
    expect(config.cdpUrl).toBe("http://127.0.0.1:9222");
    expect(config.profileName).toBe("pi-browser-default");
    expect(config.targets.map((target) => target.name)).toContain("docker-host");
  });

  it("supports explicit CDP URL and host overrides", () => {
    clearBrowserEnv();
    process.env.PI_BROWSER_CDP_URL = "http://browser.example:9222";

    expect(loadBrowserClientConfig()).toMatchObject({
      targetName: "env",
      cdpUrl: "http://browser.example:9222",
    });

    delete process.env.PI_BROWSER_CDP_URL;
    process.env.PI_BROWSER_CDP_HOST = "daily-driver";
    process.env.PI_BROWSER_CDP_PORT = "9333";

    expect(loadBrowserClientConfig()).toMatchObject({
      targetName: "env-host",
      cdpUrl: "http://daily-driver:9333",
    });
  });

  it("parses custom targets from JSON", () => {
    clearBrowserEnv();
    process.env.PI_BROWSER_TARGETS = JSON.stringify({
      lab: { host: "chromium.homelab.jnguy.dev", port: 9222, description: "lab browser" },
    });
    process.env.PI_BROWSER_TARGET = "lab";

    const config = loadBrowserClientConfig();

    expect(config.targetName).toBe("lab");
    expect(config.cdpUrl).toBe("http://chromium.homelab.jnguy.dev:9222");
    expect(config.targets.find((target) => target.name === "lab")?.description).toBe("lab browser");
  });
});

describe("BrowserClient targets", () => {
  it("selects targets without attempting a CDP connection", async () => {
    clearBrowserEnv();
    process.env.PI_BROWSER_TARGETS = JSON.stringify({ lab: "http://127.0.0.1:9333" });
    const client = new BrowserClient(loadBrowserClientConfig());

    expect(client.listTargets().find((target) => target.name === "local")?.active).toBe(true);

    const selected = await client.selectTarget("lab");

    expect(selected).toMatchObject({ name: "lab", cdpUrl: "http://127.0.0.1:9333" });
    expect(client.listTargets().find((target) => target.name === "lab")?.active).toBe(true);
  });
});

function clearBrowserEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}
