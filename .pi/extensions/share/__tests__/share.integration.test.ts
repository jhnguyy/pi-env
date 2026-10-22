import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import share from "../index";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// GitHub is the only external service replaced here. Pi performs the real HTML export.
function fixture(metadata: unknown = { private: true, permissions: { push: true } }) {
  const root = mkdtempSync(join(tmpdir(), "pi-share-test-"));
  roots.push(root);
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ theme: "dark" }));
  const session = SessionManager.create(root, join(root, "sessions"));
  session.appendMessage({ role: "user", content: "synthetic private conversation", timestamp: Date.now() });
  let command: RegisteredCommand | undefined;
  const uploads: unknown[] = [];
  const requests: string[][] = [];
  const notices: string[] = [];
  let prompts = 0;
  let answer: string | undefined = "owner/private-exports";
  let approved = true;
  const api: Partial<ExtensionAPI> = {
    on() { return () => {}; },
    registerCommand(_name: string, value: RegisteredCommand) { command = value; },
    async exec(binary: string, args: string[]) {
      if (binary === "gh") {
        requests.push(args);
        expect(args).toContain("--hostname");
        if (args.includes("PUT")) {
          const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
          uploads.push(body);
          return { code: 0, stdout: JSON.stringify({ content: { html_url: "https://github.com/owner/private-exports/blob/main/sessions/export.html" } }), stderr: "", killed: false };
        }
        return { code: 0, stdout: JSON.stringify(metadata), stderr: "", killed: false };
      }
      const result = await run(binary, args);
      return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
    },
  };
  share(api as ExtensionAPI, { globalSettingsPath: () => settings, projectSettingsPath: () => join(root, "project-settings.json"), readFile: readFileSync });
  const ui: Partial<ExtensionCommandContext["ui"]> = {
    input: async () => { prompts++; return answer; },
    confirm: async () => approved,
    notify: (text: string) => { notices.push(text); },
  };
  const context: Partial<ExtensionCommandContext> = {
    cwd: root, hasUI: true, sessionManager: session,
    waitForIdle: async () => {},
    ui: ui as ExtensionCommandContext["ui"],
  };
  return { settings, uploads, requests, notices, get prompts() { return prompts; }, cancel() { answer = undefined; }, decline() { approved = false; }, invoke: () => command!.handler("", context as ExtensionCommandContext) };
}

describe("private repository share", () => {
  it("exports through Pi, saves the first repository, and reuses it", async () => {
    const f = fixture();
    await f.invoke();
    expect(f.uploads).toHaveLength(1);
    const body = f.uploads[0] as { content: string };
    const html = Buffer.from(body.content, "base64").toString();
    const data = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    expect(data).toBeDefined();
    expect(Buffer.from(data!, "base64").toString()).toContain("synthetic private conversation");
    expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual({ theme: "dark", share: { repo: "owner/private-exports" } });
    expect(f.notices.join("\n")).toContain("https://github.com/owner/private-exports/blob/");
    await f.invoke();
    expect(f.prompts).toBe(1);
    expect(f.uploads).toHaveLength(2);
  });

  it.each([
    { private: false, permissions: { push: true } },
    { private: true, permissions: { push: false } },
    { private: true },
  ])("rejects unsafe repository metadata %j without saving or uploading", async (metadata) => {
    const f = fixture(metadata);
    await f.invoke();
    expect(f.uploads).toEqual([]);
    expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual({ theme: "dark" });
    expect(f.notices.join("\n")).toContain("Share failed");
  });

  it("uses a configured repository without prompting", async () => {
    const f = fixture();
    writeFileSync(f.settings, JSON.stringify({ share: { repo: "owner/configured" } }));
    await f.invoke();
    expect(f.prompts).toBe(0);
    expect(f.uploads).toHaveLength(1);
    expect(f.requests[0]).toContain("repos/owner/configured");
    expect(f.requests[1]?.join(" ")).toContain("repos/owner/configured/contents/sessions/");
  });

  it.each(["not-json", JSON.stringify({ share: { repo: "https://github.com/owner/repo" } })])("preserves invalid settings without uploading: %s", async (settings) => {
    const f = fixture();
    writeFileSync(f.settings, settings);
    await f.invoke();
    expect(f.uploads).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(readFileSync(f.settings, "utf8")).toBe(settings);
    expect(f.notices.join("\n")).toContain("Share failed");
  });

  it("cancels a missing-repository prompt without effects", async () => {
    const f = fixture();
    f.cancel();
    await f.invoke();
    expect(f.uploads).toEqual([]);
    expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual({ theme: "dark" });
  });

  it("does not publish when the disclosure confirmation is declined", async () => {
    const f = fixture();
    f.decline();
    await f.invoke();
    expect(f.uploads).toEqual([]);
  });
});
