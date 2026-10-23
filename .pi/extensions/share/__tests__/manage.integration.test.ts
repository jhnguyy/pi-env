import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exampleShare, fixture, privateRepository } from "./fixture";

describe("manage private shares", () => {
  it("lists names, paths, and view links from the configured branch without exporting", async () => {
    const f = fixture();
    writeFileSync(f.settings, JSON.stringify({ share: { repo: "owner/private-exports", branch: "feature/test" } }));
    await f.invoke(undefined, "list");
    const text = f.notices.join("\n");
    expect(text).toContain(exampleShare.name);
    expect(text).toContain(exampleShare.path);
    expect(text).toContain("https://github.com/");
    expect(f.requests.some((args) => args.some((arg) => arg.includes("contents/sessions?ref=feature%2Ftest")))).toBe(true);
    expect(f.events).not.toContain("export");
    expect(f.uploads).toEqual([]);
  });

  it("confirms and deletes only the selected share using its SHA and branch", async () => {
    const f = fixture();
    writeFileSync(f.settings, JSON.stringify({ share: { repo: "owner/private-exports", branch: "shares" } }));
    await f.invoke(undefined, "delete");
    expect(f.deletions).toEqual([{ path: exampleShare.path, body: expect.objectContaining({ branch: "shares", sha: exampleShare.sha }) }]);
    expect(f.confirmations[0]).toContain(exampleShare.path);
    expect(f.confirmations[0]).toContain("shares");
    expect(f.notices.join("\n")).toMatch(/history/i);
    expect(f.events).not.toContain("export");
  });

  it("does not delete when confirmation is declined", async () => {
    const f = fixture();
    f.decline();
    await f.invoke(undefined, "delete");
    expect(f.deletions).toEqual([]);
  });

  it.each(["README.md", "sessions/../README.html", "sessions/nested/file.html", "sessions/different-name.html"])("rejects an unsafe listed path: %s", async (path) => {
    const f = fixture();
    f.github.shares = [{ ...exampleShare, path }];
    await f.invoke(undefined, "delete");
    expect(f.deletions).toEqual([]);
  });

  it("does not accept a selection outside the offered shares", async () => {
    const f = fixture();
    f.select("README.md");
    await f.invoke(undefined, "delete");
    expect(f.deletions).toEqual([]);
  });

  it("does not delete a file whose SHA changed after listing", async () => {
    const f = fixture();
    f.github.currentShare = { ...exampleShare, sha: "b".repeat(40) };
    await f.invoke(undefined, "delete");
    expect(f.deletions).toEqual([]);
    expect(f.notices.join("\n")).toContain("Share failed");
  });

  it("does not delete after the repository identity changes", async () => {
    const f = fixture(privateRepository, { ...privateRepository, id: 456 });
    await f.invoke(undefined, "delete");
    expect(f.deletions).toEqual([]);
  });

  it("keeps takedown available when Pages has become public", async () => {
    const f = fixture();
    f.github.pages = { public: true, html_url: "https://public.example.test/", source: { branch: "main", path: "/" } };
    await f.invoke(undefined, "delete");
    expect(f.deletions).toHaveLength(1);
    expect(f.notices.join("\n")).not.toContain("https://public.example.test");
  });

  it("reports an empty sessions directory without offering a deletion", async () => {
    const f = fixture();
    f.github.errors.set("repos/owner/private-exports/contents/sessions", 404);
    await f.invoke(undefined, "delete");
    expect(f.deletions).toEqual([]);
    expect(f.confirmations).toEqual([]);
    expect(f.notices.join("\n")).toMatch(/no shares/i);
  });

  it("does not claim there are no shares when a 404 directory still exists in root contents", async () => {
    const f = fixture();
    f.github.errors.set("repos/owner/private-exports/contents/sessions", 404);
    f.github.rootContents = [{ ...exampleShare, type: "dir", name: "sessions", path: "sessions" }];
    await f.invoke(undefined, "list");
    expect(f.notices.join("\n")).toContain("Share failed");
    expect(f.notices.join("\n")).not.toMatch(/no shares/i);
  });

  it("does not turn inaccessible root contents into a confirmed empty directory", async () => {
    const f = fixture();
    f.github.errors.set("repos/owner/private-exports/contents/sessions", 404);
    f.github.errors.set("repos/owner/private-exports/contents", 403);
    await f.invoke(undefined, "list");
    expect(f.notices.join("\n")).toContain("Share failed");
    expect(f.notices.join("\n")).not.toMatch(/no shares/i);
  });

  it("reports an uncertain delete outcome when GitHub loses its committed response", async () => {
    const f = fixture();
    f.github.deleteResponse = "lost";
    await f.invoke(undefined, "delete");
    expect(f.deletions).toHaveLength(1);
    const notices = f.notices.join("\n");
    expect(notices).toContain(`owner/private-exports@main:${exampleShare.path}`);
    expect(notices).toContain("/share-private list");
    expect(notices).not.toContain("Share failed:");
    expect(notices).toMatch(/may|uncertain/i);
  });

  it("does not present a capped contents response as a complete list", async () => {
    const f = fixture();
    f.github.shares = Array.from({ length: 1000 }, (_, index) => ({ ...exampleShare, name: `${index}.html`, path: `sessions/${index}.html` }));
    await f.invoke(undefined, "list");
    expect(f.notices.join("\n")).toMatch(/limit|incomplete|too many/i);
  });

  it("rejects unknown actions without accessing GitHub", async () => {
    const f = fixture();
    await f.invoke(undefined, "unknown");
    expect(f.requests).toEqual([]);
    expect(f.notices.join("\n")).toMatch(/usage/i);
  });
});
