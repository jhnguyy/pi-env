import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserClient } from "../browser";
import { loadBrowserClientConfig } from "../config";

const ENV_KEYS = [
  "PI_BROWSER_PROFILE",
  "PI_BROWSER_PROFILE_PATH",
  "PI_BROWSER_ARTIFACT_DIR",
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("playwright-client config", () => {
  it("falls back to a local CDP target when settings do not define targets", () => {
    clearBrowserEnv();

    const config = loadBrowserClientConfig(tempProject());

    expect(config.profileName).toBe("pi-browser-default");
    expect(config.targets).toHaveLength(1);
    expect(config.targets[0]).toMatchObject({
      name: "local",
      host: "127.0.0.1",
      port: 9222,
      protocol: "http",
      cdpUrl: "http://127.0.0.1:9222",
    });
  });

  it("loads named targets from project settings instead of hardcoded host lists", () => {
    clearBrowserEnv();
    const cwd = tempProject({
      playwrightClient: {
        targets: {
          daily: { host: "127.0.0.1", port: 9222, description: "SSH reverse-forward" },
          mac: { host: "host.docker.internal", port: "9333", path: "json/version", protocol: "http" },
        },
      },
    });

    const config = loadBrowserClientConfig(cwd);

    expect(config.targets.map((target) => target.name)).toEqual(["daily", "mac"]);
    expect(config.targets.find((target) => target.name === "daily")).toMatchObject({
      cdpUrl: "http://127.0.0.1:9222",
      description: "SSH reverse-forward",
    });
    expect(config.targets.find((target) => target.name === "mac")).toMatchObject({
      cdpUrl: "http://host.docker.internal:9333/json/version",
    });
  });

  it("applies profile and artifact environment overrides", () => {
    clearBrowserEnv();

    process.env.PI_BROWSER_PROFILE = "pi-browser-test";
    process.env.PI_BROWSER_PROFILE_PATH = "/tmp/pi-browser-profile";
    process.env.PI_BROWSER_ARTIFACT_DIR = "/tmp/pi-browser-artifacts-test";

    expect(loadBrowserClientConfig(tempProject())).toMatchObject({
      profileName: "pi-browser-test",
      profilePath: "/tmp/pi-browser-profile",
      artifactDir: "/tmp/pi-browser-artifacts-test",
    });
  });
});

describe("BrowserClient targets", () => {
  it("lists configured targets without active target state", () => {
    clearBrowserEnv();
    const cwd = tempProject({ playwrightClient: { targets: { lab: { host: "browser.local" } } } });

    const client = new BrowserClient(loadBrowserClientConfig(cwd));
    const targets = client.listTargets();

    expect(targets.map((target) => target.name)).toEqual(["lab"]);
    expect(targets.some((target) => "active" in target)).toBe(false);
  });
});

function clearBrowserEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function tempProject(settings?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-env-browser-config-"));
  tempDirs.push(dir);
  if (settings) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify(settings));
  }
  return dir;
}
