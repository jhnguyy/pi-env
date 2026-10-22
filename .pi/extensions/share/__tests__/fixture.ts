import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFiles from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, expect } from "vitest";
import share, { type ShareFiles } from "../index";

const run = promisify(execFile);
const piCli = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
export const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export const privateRepository = { id: 123, private: true, permissions: { push: true }, default_branch: "main", has_pages: false };
export const exampleShare = { type: "file", name: "2026-10-22-example-0123456789ab.html", path: "sessions/2026-10-22-example-0123456789ab.html", sha: "a".repeat(40), html_url: "https://github.com/owner/private-exports/blob/main/sessions/2026-10-22-example-0123456789ab.html" };

// GitHub is replaced at its process adapter. Pi exports and local files remain real.
export function fixture(...repositories: unknown[]) {
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
  const uploads: Array<Record<string, unknown>> = [];
  const deletions: Array<{ path: string; body: Record<string, unknown> }> = [];
  const requests: string[][] = [];
  const events: string[] = [];
  const notices: string[] = [];
  const confirmations: string[] = [];
  const github = {
    pages: undefined as unknown,
    branches: new Set(["main", "shares", "feature/test"]),
    shares: [exampleShare] as unknown[],
    currentShare: exampleShare as unknown,
    rootContents: [] as unknown[],
    uploadResponse: undefined as "malformed" | "lost" | undefined,
    deleteResponse: undefined as "lost" | undefined,
    abortOnCommit: undefined as AbortController | undefined,
    errors: new Map<string, number>(),
  };
  let prompts = 0;
  let answer: string | undefined = "owner/private-exports";
  let approved = true;
  let selected: string | undefined;
  const files: ShareFiles = { ...nodeFiles };
  const api: Partial<ExtensionAPI> = {
    registerCommand(name: string, value: RegisteredCommand) { expect(name).toBe("share-private"); command = value; },
    async exec(binary, args, options) {
      if (binary !== "gh") {
        events.push("export");
        const result = await run(process.execPath, [piCli, ...args], { signal: options?.signal });
        return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
      }
      requests.push(args);
      expect(args).toContain("--hostname");
      const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
      const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
      const route = endpoint.split("?")[0];
      let status = github.errors.get(route) ?? 200;
      let data: unknown;
      if (status !== 200) data = { message: "synthetic GitHub error" };
      else if (method === "PUT" || method === "DELETE") {
        const body: Record<string, unknown> = args.includes("--input")
          ? JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"))
          : {};
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] === "-f" || args[i] === "-F") {
            const field = args[++i];
            const separator = field.indexOf("=");
            body[field.slice(0, separator)] = field.slice(separator + 1);
          }
        }
        if (method === "PUT") {
          events.push("upload");
          uploads.push(body);
          status = 201;
          data = { content: { html_url: `https://github.com/owner/private-exports/blob/${String(body["branch"] ?? "main")}/${route.split("/contents/")[1]}` } };
        } else {
          events.push("delete");
          deletions.push({ path: route.split("/contents/")[1], body });
          data = { content: null, commit: { sha: "b".repeat(40) } };
        }
      } else if (route.includes("/branches/")) {
        events.push("branch");
        const branch = decodeURIComponent(route.split("/branches/")[1]);
        status = github.branches.has(branch) ? 200 : 404;
        data = { name: branch };
      } else if (route.endsWith("/pages")) {
        events.push("pages");
        status = github.pages === undefined ? 404 : 200;
        data = github.pages ?? { message: "Not Found" };
      } else if (route.endsWith("/contents/sessions")) {
        events.push("list");
        data = github.shares;
      } else if (route.endsWith("/contents")) {
        events.push("root");
        data = github.rootContents;
      } else if (route.includes("/contents/")) {
        events.push("file");
        data = github.currentShare;
      } else {
        events.push("repository");
        const repository = repositories[Math.min(checks++, repositories.length - 1)];
        data = typeof repository === "object" && repository !== null
          ? { ...repository, has_pages: github.pages !== undefined || ("has_pages" in repository && repository.has_pages === true) }
          : repository;
      }
      if (method === "PUT" || method === "DELETE") github.abortOnCommit?.abort();
      if ((method === "PUT" && github.uploadResponse === "lost") || (method === "DELETE" && github.deleteResponse === "lost")) {
        return { code: 1, stdout: "", stderr: "synthetic connection reset after commit", killed: false };
      }
      const body = method === "PUT" && github.uploadResponse === "malformed" ? "invalid-json" : JSON.stringify(data);
      const stdout = args.includes("--include") ? `HTTP/2.0 ${status} Synthetic\r\ncontent-type: application/json\r\n\r\n${body}` : body;
      return { code: status >= 400 ? 1 : 0, stdout, stderr: status >= 400 ? `gh: synthetic error (HTTP ${status})` : "", killed: false };
    },
  };
  share(api as ExtensionAPI, { globalSettingsPath: () => settings, projectSettingsPath: () => projectSettings, readFile: readFileSync }, files);
  const ui: Partial<ExtensionCommandContext["ui"]> = {
    input: async () => { prompts++; return answer; },
    confirm: async (_title, message) => { events.push("confirm"); confirmations.push(message); return approved; },
    select: async (_title, options) => selected ?? options[0],
    notify: (text) => { notices.push(text); },
  };
  const context: Partial<ExtensionCommandContext> = {
    cwd: root, hasUI: true, sessionManager: session, waitForIdle: async () => {}, ui: ui as ExtensionCommandContext["ui"],
  };
  return {
    settings, projectSettings, files, session, github, uploads, deletions, requests, events, notices, confirmations,
    get prompts() { return prompts; },
    cancel() { answer = undefined; },
    decline() { approved = false; },
    select(value: string) { selected = value; },
    invoke: (signal?: AbortSignal, args = "") => {
      context.signal = signal;
      return command!.handler(args, context as ExtensionCommandContext);
    },
  };
}
