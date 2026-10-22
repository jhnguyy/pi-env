import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import share from "../index";

const run = promisify(execFile);
const piCli = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// GitHub is the only external service replaced here. Pi performs the real HTML export.
const privateRepository = { id: 123, private: true, permissions: { push: true } };

function fixture(...repositories: unknown[]) {
  if (repositories.length === 0) repositories.push(privateRepository);
  let checks = 0;
  const root = mkdtempSync(join(tmpdir(), "pi-share-test-"));
  roots.push(root);
  const settings = join(root, "settings.json");
  const projectSettings = join(root, "project-settings.json");
  writeFileSync(settings, JSON.stringify({ theme: "dark" }));
  const session = SessionManager.create(root, join(root, "sessions"));
  session.appendMessage({ role: "user", content: "synthetic private conversation", timestamp: Date.now() });
  let command: RegisteredCommand | undefined;
  const uploads: unknown[] = [];
  const requests: string[][] = [];
  const events: string[] = [];
  const notices: string[] = [];
  let prompts = 0;
  let answer: string | undefined = "owner/private-exports";
  let approved = true;
  const api: Partial<ExtensionAPI> = {
    registerCommand(_name: string, value: RegisteredCommand) { command = value; },
    async exec(binary: string, args: string[]) {
      if (binary === "gh") {
        requests.push(args);
        expect(args).toContain("--hostname");
        if (args.includes("PUT")) {
          events.push("upload");
          const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
          uploads.push(body);
          return { code: 0, stdout: JSON.stringify({ content: { html_url: "https://github.com/owner/private-exports/blob/main/sessions/export.html" } }), stderr: "", killed: false };
        }
        events.push("repository");
        return { code: 0, stdout: JSON.stringify(repositories[Math.min(checks++, repositories.length - 1)]), stderr: "", killed: false };
      }
      events.push("export");
      const result = await run(process.execPath, [piCli, ...args]);
      return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
    },
  };
  share(api as ExtensionAPI, { globalSettingsPath: () => settings, projectSettingsPath: () => projectSettings, readFile: readFileSync });
  const ui: Partial<ExtensionCommandContext["ui"]> = {
    input: async () => { prompts++; return answer; },
    confirm: async () => { events.push("confirm"); return approved; },
    notify: (text: string) => { notices.push(text); },
  };
  const context: Partial<ExtensionCommandContext> = {
    cwd: root, hasUI: true, sessionManager: session,
    waitForIdle: async () => {},
    ui: ui as ExtensionCommandContext["ui"],
  };
  return { settings, projectSettings, uploads, requests, events, notices, get prompts() { return prompts; }, cancel() { answer = undefined; }, decline() { approved = false; }, invoke: () => command!.handler("", context as ExtensionCommandContext) };
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
    { ...privateRepository, private: false },
    { ...privateRepository, permissions: { push: false } },
    { id: 123, private: true },
  ])("rejects unsafe repository metadata %j without saving or uploading", async (metadata) => {
    const f = fixture(metadata);
    await f.invoke();
    expect(f.uploads).toEqual([]);
    expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual({ theme: "dark" });
    expect(f.notices.join("\n")).toContain("Share failed");
  });

  it.each([
    { ...privateRepository, private: false },
    { ...privateRepository, permissions: { push: false } },
    { ...privateRepository, id: 456 },
  ])("does not upload when the confirmed repository changes: %j", async (changedRepository) => {
    const f = fixture(privateRepository, changedRepository);
    await f.invoke();
    expect(f.events).toEqual(["repository", "confirm", "export", "repository"]);
    expect(f.uploads).toEqual([]);
    expect(f.notices.join("\n")).toContain("Share failed");
  });

  it.each([false, true])("rejects a symlinked settings file without replacing it (dangling=%s)", async (dangling) => {
    const f = fixture();
    const target = `${f.settings}.target`;
    const original = readFileSync(f.settings, "utf8");
    if (!dangling) writeFileSync(target, original);
    rmSync(f.settings);
    symlinkSync(target, f.settings);
    await f.invoke();
    expect(lstatSync(f.settings).isSymbolicLink()).toBe(true);
    if (!dangling) expect(readFileSync(target, "utf8")).toBe(original);
    expect(f.uploads).toEqual([]);
    expect(f.notices.join("\n")).toContain("symlink");
  });

  it("uses a configured repository without prompting", async () => {
    const f = fixture();
    writeFileSync(f.settings, JSON.stringify({ share: { repo: "owner/configured" } }));
    await f.invoke();
    expect(f.prompts).toBe(0);
    expect(f.uploads).toHaveLength(1);
    expect(f.requests[0]).toContain("repos/owner/configured");
    expect(f.requests.find((args) => args.includes("PUT"))?.join(" ")).toContain("repos/owner/configured/contents/sessions/");
  });

  it.each(["not-json", JSON.stringify({ share: { repo: "https://github.com/owner/repo" } })])("preserves invalid settings without uploading: %s", async (settings) => {
    const f = fixture();
    writeFileSync(f.settings, settings);
    await f.invoke();
    expect(f.uploads).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(readFileSync(f.settings, "utf8")).toBe(settings);
    expect(f.notices.join("\n")).toContain(f.settings);
  });

  it("reports the unreadable settings path before any GitHub request", async () => {
    const f = fixture();
    mkdirSync(f.projectSettings);
    await f.invoke();
    expect(f.requests).toEqual([]);
    expect(f.notices.join("\n")).toContain(`Could not read project settings at ${f.projectSettings}`);
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
