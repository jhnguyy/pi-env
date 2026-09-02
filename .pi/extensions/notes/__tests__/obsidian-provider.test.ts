import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_NOTE_BYTES, NotesProviderError } from "../domain";
import { createObsidianProvider, type ObsidianProviderOptions } from "../obsidian-provider";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: ObsidianProviderOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-notes-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  await mkdir(vault);
  const provider = await createObsidianProvider(vault, options);
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

  it("rejects traversal, symbolic-link notes, and canonical hidden targets", async () => {
    const { root, vault, provider } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.md"), "secret");
    await mkdir(path.join(vault, ".obsidian", "plugins"), { recursive: true });
    await writeFile(path.join(vault, ".obsidian", "plugins", "main.js"), "secret");
    await symlink(outside, path.join(vault, "escape"));
    await symlink(path.join(vault, ".obsidian", "plugins", "main.js"), path.join(vault, "safe.md"));

    await expect(provider.read("../outside/secret.md")).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "path-escape",
    });
    await expect(provider.read("escape/secret.md")).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "path-escape",
    });
    await expect(provider.read("safe.md")).rejects.toMatchObject({ code: "path-escape" });
    await expect(
      provider.write({ path: "escape/new.md", content: "unsafe", expectedRevision: null }),
    ).rejects.toMatchObject({ _tag: "NotesProviderError", code: "path-escape" });
  });

  it("resolves the Obsidian daily note and canonical dated records", async () => {
    const now = new Date(2026, 8, 1, 12);
    const { vault, provider } = await fixture({ now: () => now });
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

  it("rejects Daily Notes settings that link outside the vault", async () => {
    const { root, vault, provider } = await fixture({ now: () => new Date(2026, 8, 1, 12) });
    const outside = path.join(root, "daily-notes.json");
    await writeFile(outside, JSON.stringify({ folder: "inbox" }));
    await mkdir(path.join(vault, ".obsidian"));
    await symlink(outside, path.join(vault, ".obsidian", "daily-notes.json"));

    await expect(provider.resolve("daily/today")).rejects.toMatchObject({ code: "path-escape" });
  });

  it("does not treat non-missing path failures as permission to create", async () => {
    const { vault, provider } = await fixture();
    await symlink("loop", path.join(vault, "loop"));

    await expect(
      provider.write({ path: "loop/note.md", content: "unsafe", expectedRevision: null }),
    ).rejects.not.toMatchObject({ code: "not-found" });
  });

  it("serializes directory aliases on the canonical target", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let commits = 0;
    const { vault, provider } = await fixture({
      beforeCommit: async (_target, operation) => {
        if (operation !== "replace") return;
        commits += 1;
        started();
        await blocked;
      },
    });
    await mkdir(path.join(vault, "real"));
    await writeFile(path.join(vault, "real", "note.md"), "first");
    await symlink(path.join(vault, "real"), path.join(vault, "alias"));
    const note = await provider.read("real/note.md");

    const first = provider.write({
      path: "real/note.md",
      content: "first writer",
      expectedRevision: note.revision,
    });
    await entered;
    const second = provider.write({
      path: "alias/note.md",
      content: "second writer",
      expectedRevision: note.revision,
    });
    release();

    await expect(first).resolves.toMatchObject({ path: "real/note.md" });
    await expect(second).rejects.toMatchObject({ code: "conflict" });
    expect(commits).toBe(1);
  });

  it("rechecks replace and delete revisions at the commit boundary", async () => {
    let operation: string | undefined;
    let target: string | undefined;
    const fixtureState = await fixture({
      beforeCommit: async (nextTarget, nextOperation) => {
        operation = nextOperation;
        target = nextTarget;
        await writeFile(nextTarget, `external ${nextOperation}`);
      },
    });
    const { vault, provider } = fixtureState;
    await writeFile(path.join(vault, "note.md"), "first");
    const first = await provider.read("note.md");

    await expect(
      provider.write({ path: "note.md", content: "replacement", expectedRevision: first.revision }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(operation).toBe("replace");
    expect(target).toBe(path.join(vault, "note.md"));
    await expect(readFile(path.join(vault, "note.md"), "utf8")).resolves.toBe("external replace");

    const second = await provider.read("note.md");
    await expect(
      provider.delete({ path: "note.md", expectedRevision: second.revision }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(operation).toBe("delete");
    await expect(readFile(path.join(vault, "note.md"), "utf8")).resolves.toBe("external delete");
  });

  it("uses an atomic absent check when creating a note", async () => {
    const { vault, provider } = await fixture({
      beforeCommit: async (target, operation) => {
        if (operation === "create") await writeFile(target, "external creation");
      },
    });

    await expect(
      provider.write({ path: "note.md", content: "ours", expectedRevision: null }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(readFile(path.join(vault, "note.md"), "utf8")).resolves.toBe("external creation");
  });

  it("bounds note content and preserves mode bits on replacement", async () => {
    const { vault, provider } = await fixture();
    const notePath = path.join(vault, "note.md");
    await writeFile(notePath, "first", { mode: 0o640 });
    await chmod(notePath, 0o640);
    const note = await provider.read("note.md");
    await provider.write({ path: "note.md", content: "second", expectedRevision: note.revision });
    expect((await stat(notePath)).mode & 0o777).toBe(0o640);

    const oversized = "x".repeat(MAX_NOTE_BYTES + 1);
    await expect(
      provider.write({ path: "large.md", content: oversized, expectedRevision: null }),
    ).rejects.toMatchObject({ code: "resource-limit" });
    await writeFile(path.join(vault, "large.md"), oversized);
    await expect(provider.read("large.md")).rejects.toMatchObject({ code: "resource-limit" });
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
