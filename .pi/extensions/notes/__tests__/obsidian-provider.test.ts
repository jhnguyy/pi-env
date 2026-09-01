import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotesProviderError } from "../domain";
import { createObsidianProvider } from "../obsidian-provider";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-notes-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  await mkdir(vault);
  const provider = await createObsidianProvider(vault);
  return { root, vault, provider };
}

describe("Obsidian notes provider", () => {
  it("filters list and search through canonical areas", async () => {
    const { vault, provider } = await fixture();
    await mkdir(path.join(vault, "wiki"));
    await mkdir(path.join(vault, "records", "worklog"), { recursive: true });
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, "wiki", "topic.md"), "# Topic\nsearch target");
    await writeFile(path.join(vault, "records", "worklog", "day.md"), "# Day\nsearch target");
    await writeFile(path.join(vault, ".obsidian", "workspace.md"), "search target");
    await writeFile(path.join(vault, "ignored.txt"), "search target");

    const wiki = await provider.list({ area: "wiki" });
    const results = await provider.search({ query: "search target", areas: ["worklog"] });

    expect(wiki.map((note) => note.path)).toEqual(["wiki/topic.md"]);
    expect(results.map((result) => result.path)).toEqual(["records/worklog/day.md"]);
  });

  it("creates a note only with an absent precondition and returns a readable revision", async () => {
    const { vault, provider } = await fixture();
    const created = await provider.write({
      path: "wiki/topic.md",
      content: "# Topic\nCurrent understanding.",
      expectedRevision: null,
    });
    const note = await provider.read("wiki/topic.md");

    expect(note.content).toBe("# Topic\nCurrent understanding.");
    expect(note.revision).toBe(created.revision);
    await expect(readFile(path.join(vault, "wiki", "topic.md"), "utf8")).resolves.toBe(
      note.content,
    );
    await expect(
      provider.write({ path: "wiki/topic.md", content: "overwrite", expectedRevision: null }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects stale writes and preserves the current note", async () => {
    const { vault, provider } = await fixture();
    const notePath = path.join(vault, "note.md");
    await writeFile(notePath, "first");
    const first = await provider.read("note.md");
    await writeFile(notePath, "external change");

    await expect(
      provider.write({
        path: "note.md",
        content: "stale overwrite",
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(readFile(notePath, "utf8")).resolves.toBe("external change");
  });

  it("rejects traversal and symlink escapes", async () => {
    const { root, vault, provider } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(outside, path.join(vault, "escape"));

    await expect(provider.read("../outside/secret.md")).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "path-escape",
    });
    await expect(provider.read("escape/secret.md")).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "path-escape",
    });
    await expect(
      provider.write({ path: "escape/new.md", content: "unsafe", expectedRevision: null }),
    ).rejects.toMatchObject({ _tag: "NotesProviderError", code: "path-escape" });
  });

  it("resolves the Obsidian daily note and canonical dated records", async () => {
    const { vault, provider } = await fixture();
    const now = new Date();
    const year = String(now.getFullYear()).padStart(4, "0");
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    await mkdir(path.join(vault, ".obsidian"));
    await mkdir(path.join(vault, "inbox", "daily"), { recursive: true });
    await mkdir(path.join(vault, "records", "worklog", year, month), { recursive: true });
    await writeFile(
      path.join(vault, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "inbox/daily", format: "YYYY/MM/DD" }),
    );
    await mkdir(path.join(vault, "inbox", "daily", year, month), { recursive: true });
    await writeFile(path.join(vault, "inbox", "daily", year, month, `${day}.md`), "daily");
    await writeFile(path.join(vault, "records", "worklog", year, month, `${day}.md`), "worklog");

    await expect(provider.resolve("daily/today")).resolves.toMatchObject({ content: "daily" });
    await expect(provider.resolve("worklog/today")).resolves.toMatchObject({ content: "worklog" });
    await expect(provider.resolve("other/today")).rejects.toMatchObject({
      code: "unsupported-reference",
    });
  });

  it("deletes only when the current revision matches", async () => {
    const { vault, provider } = await fixture();
    await writeFile(path.join(vault, "delete.md"), "remove me");
    await mkdir(path.join(vault, "directory.md"));
    const note = await provider.read("delete.md");

    await expect(
      provider.delete({ path: "delete.md", expectedRevision: "stale" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await provider.delete({ path: "delete.md", expectedRevision: note.revision });
    await expect(provider.read("delete.md")).rejects.toMatchObject({ code: "not-found" });
    await expect(
      provider.delete({ path: "directory.md", expectedRevision: "revision" }),
    ).rejects.toBeInstanceOf(NotesProviderError);
  });

  it("does not create a file when cancellation is already requested", async () => {
    const { vault, provider } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.write(
        { path: "cancelled.md", content: "content", expectedRevision: null },
        controller.signal,
      ),
    ).rejects.toBeDefined();
    await expect(readFile(path.join(vault, "cancelled.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
