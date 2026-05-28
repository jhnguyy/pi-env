import { afterEach, describe, expect, it } from "vitest";

import { BrowserClient } from "../browser";
import { loadBrowserClientConfig } from "../config";

const ENV_KEYS = [
  "PI_BROWSER_PROFILE",
  "PI_BROWSER_PROFILE_PATH",
  "PI_BROWSER_ARTIFACT_DIR",
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
  it("defines built-in named targets without selecting a default target", () => {
    clearBrowserEnv();

    const config = loadBrowserClientConfig();

    expect(config).not.toHaveProperty("targetName");
    expect(config).not.toHaveProperty("cdpUrl");
    expect(config.profileName).toBe("pi-browser-default");
    expect(config.targets.find((target) => target.name === "local")).toMatchObject({
      host: "127.0.0.1",
      port: 9222,
      protocol: "http",
      cdpUrl: "http://127.0.0.1:9222",
    });
    expect(config.targets.find((target) => target.name === "colima")).toMatchObject({
      host: "host.docker.internal",
      port: 9222,
      protocol: "http",
      cdpUrl: "http://host.docker.internal:9222",
    });
  });

  it("applies profile and artifact environment overrides only", () => {
    clearBrowserEnv();

    process.env.PI_BROWSER_PROFILE = "pi-browser-test";
    process.env.PI_BROWSER_PROFILE_PATH = "/tmp/pi-browser-profile";
    process.env.PI_BROWSER_ARTIFACT_DIR = "/tmp/pi-browser-artifacts-test";

    expect(loadBrowserClientConfig()).toMatchObject({
      profileName: "pi-browser-test",
      profilePath: "/tmp/pi-browser-profile",
      artifactDir: "/tmp/pi-browser-artifacts-test",
    });
  });
});

describe("BrowserClient targets", () => {
  it("lists configured targets without active target state", () => {
    clearBrowserEnv();

    const client = new BrowserClient(loadBrowserClientConfig());
    const targets = client.listTargets();

    expect(targets.map((target) => target.name)).toContain("local");
    expect(targets.map((target) => target.name)).toContain("colima");
    expect(targets.some((target) => "active" in target)).toBe(false);
  });
});

function clearBrowserEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}
