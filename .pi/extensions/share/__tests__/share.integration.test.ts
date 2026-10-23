import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture, privateRepository, roots } from "./fixture";

describe("private repository share", () => {
  it("explicitly claims native share using the same handler as the private alias", () => {
    const f = fixture();
    expect(f.commands.get("share")?.overrideBuiltin).toBe(true);
    expect(f.commands.get("share")?.handler).toBe(f.commands.get("share-private")?.handler);
  });

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
    expect(f.requests.find((args) => args.includes("PUT"))?.join(" ")).toMatch(/\d{4}-\d{2}-\d{2}-synthetic-private-conversation-[a-f0-9]+\.html/);
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
    expect(f.events.indexOf("confirm")).toBeLessThan(f.events.lastIndexOf("repository"));
    expect(f.events.indexOf("export")).toBeLessThan(f.events.lastIndexOf("repository"));
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

  it.each(["malformed", "lost"] as const)("reports committed uploads with an unusable %s response without inviting a blind retry", async (response) => {
    const f = fixture();
    f.github.uploadResponse = response;
    await f.invoke();
    expect(f.uploads).toHaveLength(1);
    const notices = f.notices.join("\n");
    expect(notices).toContain("owner/private-exports@main:sessions/");
    expect(notices).toContain("/share-private list");
    expect(notices).not.toContain("Share failed:");
    expect(notices).not.toContain("Shared privately:");
    expect(notices).toMatch(response === "malformed" ? /uploaded/i : /may|uncertain/i);
  });

  it("warns about retained sensitive exports without reporting a successful upload as failed", async () => {
    const f = fixture();
    f.files.rm = async (path) => {
      if (typeof path === "string") roots.push(path);
      throw new Error("synthetic cleanup failure");
    };
    await expect(f.invoke()).resolves.toBeUndefined();
    expect(f.uploads).toHaveLength(1);
    expect(f.notices.join("\n")).toContain("Shared privately:");
    expect(f.notices.join("\n")).toContain("sensitive session data");
    expect(f.notices.join("\n")).not.toContain("Share failed:");
  });

  it.each(["upload", "delete"] as const)("warns when %s commits before cancellation interrupts the response", async (action) => {
    const f = fixture();
    const controller = new AbortController();
    f.github.abortOnCommit = controller;
    await expect(f.invoke(controller.signal, action)).rejects.toBeDefined();
    expect(action === "upload" ? f.uploads : f.deletions).toHaveLength(1);
    const notices = f.notices.join("\n");
    expect(notices).toContain("owner/private-exports@main:sessions/");
    expect(notices).toContain("/share-private list");
    expect(notices).toMatch(/may|uncertain/i);
  });

  it("does not start publication when its operation is already aborted", async () => {
    const f = fixture();
    await expect(f.invoke(AbortSignal.abort())).rejects.toBeDefined();
    expect(f.requests).toEqual([]);
    expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual({ theme: "dark" });
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
