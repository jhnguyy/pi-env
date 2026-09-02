import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  it("provides bounded store orientation and provider-neutral inventory", async () => {
    const { vault, provider } = await fixture();
    await mkdir(path.join(vault, "projects"));
    await mkdir(path.join(vault, "knowledge"));
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, "projects", "topic.md"), "# Topic\nsearch target");
    await writeFile(path.join(vault, "knowledge", "day.md"), "# Day\nsearch target");
    await writeFile(path.join(vault, ".obsidian", "workspace.md"), "search target");
    await writeFile(path.join(vault, "ignored.txt"), "search target");

    const index = await provider.index();
    const projects = await provider.list({ prefix: "projects", limit: 1 });
    const results = await provider.search({ query: "search target", limit: 1 });

    expect(index.text).toContain("projects(1)");
    expect(index.text).toContain("knowledge(1)");
    expect(index.text).not.toContain(".obsidian");
    expect(projects.map((note) => note.path)).toEqual(["projects/topic.md"]);
    expect(results).toHaveLength(1);
  });

  it("omits filesystem names that cannot round-trip through portable paths", async () => {
    const { vault, provider } = await fixture();
    await writeFile(path.join(vault, "wiki\\victim.md"), "unsafe name");
    await writeFile(path.join(vault, "@note.md"), "unsafe name");
    await writeFile(path.join(vault, "line\nbreak.md"), "unsafe name");
    await writeFile(path.join(vault, "normal.md"), "normal");

    await expect(provider.list({})).resolves.toEqual([
      expect.objectContaining({ path: "normal.md" }),
    ]);
  });

  it("bounds vault traversal depth", async () => {
    const { vault, provider } = await fixture();
    let directory = vault;
    for (let depth = 0; depth < 66; depth += 1) {
      directory = path.join(directory, "d");
      await mkdir(directory);
    }

    await expect(provider.list({})).rejects.toMatchObject({ code: "resource-limit" });
  });

  it("scopes revisions to note path and file identity", async () => {
    const { vault, provider } = await fixture();
    await writeFile(path.join(vault, "one.md"), "same content");
    await writeFile(path.join(vault, "two.md"), "same content");

    const one = await provider.read("one.md");
    const two = await provider.read("two.md");
    expect(one.revision).not.toBe(two.revision);
    await expect(
      provider.write({ path: "two.md", content: "unsafe", expectedRevision: one.revision }),
    ).rejects.toMatchObject({ code: "conflict" });
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

  it("rejects a read when the resolved file identity changes before open", async () => {
    let vault = "";
    const fixtureState = await fixture({
      afterReadTargetResolved: async (_notePath, target) => {
        const replacement = path.join(vault, "replacement.md");
        await writeFile(replacement, "replacement");
        await rename(replacement, target);
      },
    });
    vault = fixtureState.vault;
    await writeFile(path.join(vault, "note.md"), "original");

    await expect(fixtureState.provider.read("note.md")).rejects.toMatchObject({ code: "conflict" });
  });

  it("treats missing guarded mutation targets as conflicts", async () => {
    const { provider } = await fixture();
    await expect(
      provider.write({ path: "missing.md", content: "content", expectedRevision: "revision" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      provider.delete({ path: "missing.md", expectedRevision: "revision" }),
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

  it("rejects hard-linked notes that bypass canonical containment", async () => {
    const { root, vault, provider } = await fixture();
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside");
    await link(outside, path.join(vault, "linked.md"));

    await expect(provider.read("linked.md")).rejects.toMatchObject({ code: "path-escape" });
    await expect(provider.list({})).resolves.toEqual([]);
  });

  it("rejects traversal, symbolic-link notes, and canonical hidden targets", async () => {
    const { root, vault, provider } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.md"), "secret");
    await mkdir(path.join(vault, ".obsidian", "plugins"), { recursive: true });
    await writeFile(path.join(vault, ".obsidian", "plugins", "main.js"), "secret");
    await symlink(outside, path.join(vault, "escape"));
    await symlink(path.join(vault, ".obsidian"), path.join(vault, "metadata"));
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
    await expect(
      provider.write({ path: "metadata/new/note.md", content: "unsafe", expectedRevision: null }),
    ).rejects.toMatchObject({ code: "path-escape" });
    await expect(lstat(path.join(outside, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(vault, ".obsidian", "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not treat non-missing path failures as permission to create", async () => {
    const { vault, provider } = await fixture();
    await symlink("loop", path.join(vault, "loop"));

    await expect(
      provider.write({ path: "loop/note.md", content: "unsafe", expectedRevision: null }),
    ).rejects.toMatchObject({ code: "path-escape" });
    expect((await lstat(path.join(vault, "loop"))).isSymbolicLink()).toBe(true);
  });

  it("rejects directory aliases even when they stay inside the vault", async () => {
    const { vault, provider } = await fixture();
    await mkdir(path.join(vault, "real"));
    await writeFile(path.join(vault, "real", "note.md"), "first");
    await symlink(path.join(vault, "real"), path.join(vault, "alias"));

    await expect(provider.read("alias/note.md")).rejects.toMatchObject({ code: "path-escape" });
    await expect(
      provider.write({ path: "alias/new.md", content: "unsafe", expectedRevision: null }),
    ).rejects.toMatchObject({ code: "path-escape" });
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
    await writeFile(notePath, "first", { mode: 0o1640 });
    await chmod(notePath, 0o1640);
    const initialMetadata = await stat(notePath);
    const stale = await provider.read("note.md");
    await chmod(notePath, 0o1644);
    await expect(
      provider.write({ path: "note.md", content: "stale", expectedRevision: stale.revision }),
    ).rejects.toMatchObject({ code: "conflict" });
    await chmod(notePath, 0o1640);
    const note = await provider.read("note.md");
    await provider.write({ path: "note.md", content: "second", expectedRevision: note.revision });
    const finalMetadata = await stat(notePath);
    expect(finalMetadata.mode & 0o7777).toBe(0o1640);
    expect(finalMetadata.uid).toBe(initialMetadata.uid);
    expect(finalMetadata.gid).toBe(initialMetadata.gid);

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

  it("rejects portable paths that can address Windows alternate streams", async () => {
    const { provider } = await fixture();
    await expect(
      provider.write({ path: "visible.txt:private.md", content: "unsafe", expectedRevision: null }),
    ).rejects.toMatchObject({ code: "invalid-path" });
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
