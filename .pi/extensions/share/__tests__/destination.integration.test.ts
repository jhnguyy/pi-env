import { writeFileSync } from "node:fs";
import * as nodeFiles from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { fixture, privateRepository } from "./fixture";

const privatePages = { public: false, build_type: "legacy", html_url: "https://private.example.test/project/", source: { branch: "shares", path: "/" } };

describe("share destination", () => {
  it.each(["shares", "feature/test"])("pins the configured branch %s in confirmation and upload", async (branch) => {
    const f = fixture();
    writeFileSync(f.settings, JSON.stringify({ share: { repo: "owner/private-exports", branch } }));
    await f.invoke();
    expect(f.uploads[0]?.["branch"]).toBe(branch);
    expect(f.confirmations[0]).toContain(branch);
    expect(f.events.indexOf("branch")).toBeLessThan(f.events.indexOf("confirm"));
  });

  it("pins the repository default branch when no branch is configured", async () => {
    const f = fixture();
    await f.invoke();
    expect(f.uploads[0]?.["branch"]).toBe("main");
  });

  it("rejects a missing branch before confirmation", async () => {
    const f = fixture();
    writeFileSync(f.settings, JSON.stringify({ share: { repo: "owner/private-exports", branch: "missing" } }));
    await f.invoke();
    expect(f.confirmations).toEqual([]);
    expect(f.uploads).toEqual([]);
    expect(f.notices.join("\n")).toContain("Share failed");
  });

  it("names the export from the date, sanitized session name, and a collision-resistant ID", async () => {
    const f = fixture();
    f.session.appendSessionInfo("Readable ../ Demo ✨");
    await f.invoke();
    const endpoint = f.requests.find((args) => args.includes("PUT"))?.find((arg) => arg.startsWith("repos/"));
    expect(endpoint).toMatch(/\/contents\/sessions\/\d{4}-\d{2}-\d{2}-readable-demo-[a-f0-9]{12,32}\.html$/);
  });

  it("returns an authenticated private Pages link for the matching branch and root source", async () => {
    const f = fixture();
    f.github.pages = privatePages;
    writeFileSync(f.settings, JSON.stringify({ share: { repo: "owner/private-exports", branch: "shares" } }));
    await f.invoke();
    expect(f.uploads).toHaveLength(1);
    expect(f.notices.join("\n")).toContain("https://private.example.test/project/sessions/");
    expect(f.notices.join("\n")).toMatch(/deploy/i);
  });

  it.each([
    { ...privatePages, source: { branch: "other", path: "/" } },
    { ...privatePages, source: { branch: "shares", path: "/docs" } },
    { ...privatePages, build_type: "workflow" },
    { ...privatePages, build_type: undefined },
  ])("uses the blob link when private Pages does not serve the upload: %j", async (pages) => {
    const f = fixture();
    f.github.pages = pages;
    writeFileSync(f.settings, JSON.stringify({ share: { repo: "owner/private-exports", branch: "shares" } }));
    await f.invoke();
    expect(f.uploads).toHaveLength(1);
    expect(f.notices.join("\n")).toContain("https://github.com/owner/private-exports/blob/");
    expect(f.notices.join("\n")).not.toContain("https://private.example.test");
  });

  it.each([true, undefined])("does not upload when Pages public visibility is unsafe: %s", async (visibility) => {
    const f = fixture();
    f.github.pages = { ...privatePages, public: visibility };
    await f.invoke();
    expect(f.confirmations).toEqual([]);
    expect(f.uploads).toEqual([]);
    expect(f.notices.join("\n")).toContain("Share failed");
  });

  it.each([403, 404, 500])("does not treat a Pages lookup failure as no Pages site: HTTP %s", async (status) => {
    const f = fixture({ ...privateRepository, has_pages: true });
    f.github.errors.set("repos/owner/private-exports/pages", status);
    await f.invoke();
    expect(f.uploads).toEqual([]);
    expect(f.confirmations).toEqual([]);
  });

  it.each([false, true])("rechecks Pages visibility after export and before upload (site initially present=%s)", async (present) => {
    const f = fixture();
    if (present) f.github.pages = privatePages;
    f.files.writeFile = async (...args) => {
      await nodeFiles.writeFile(...args);
      f.github.pages = { ...privatePages, public: true };
    };
    await f.invoke();
    expect(f.confirmations).toHaveLength(1);
    expect(f.events).toContain("export");
    expect(f.uploads).toEqual([]);
  });
});
