import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { NotesProviderError } from "../domain";
import { createObsidianProviderEffect } from "../obsidian-provider";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-notes-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  await mkdir(vault);
  const provider = await Effect.runPromise(createObsidianProviderEffect(vault));
  return { root, vault, provider };
}

describe("Obsidian notes provider", () => {
  it("lists and searches Markdown notes deterministically without Obsidian metadata", async () => {
    const { vault, provider } = await fixture();
    await mkdir(path.join(vault, "projects"));
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, "z.md"), "# Zed\nportable knowledge");
    await writeFile(path.join(vault, "projects", "a.md"), "# Alpha\nsearch target");
    await writeFile(path.join(vault, ".obsidian", "workspace.md"), "search target");
    await writeFile(path.join(vault, "ignored.txt"), "search target");

    const notes = await Effect.runPromise(provider.list());
    const results = await Effect.runPromise(provider.search("search target"));
    const index = await Effect.runPromise(provider.index());

    expect(notes.map((note) => note.path)).toEqual(["projects/a.md", "z.md"]);
    expect(results.map((result) => result.path)).toEqual(["projects/a.md"]);
    expect(index).toContain("provider:obsidian|count:2");
    expect(index).not.toContain(".obsidian");
  });

  it("writes and reads a note through a new contained directory", async () => {
    const { vault, provider } = await fixture();

    await Effect.runPromise(provider.write("wiki/topic.md", "# Topic\nCurrent understanding."));

    await expect(Effect.runPromise(provider.read("wiki/topic.md"))).resolves.toBe(
      "# Topic\nCurrent understanding.",
    );
    await expect(readFile(path.join(vault, "wiki", "topic.md"), "utf8")).resolves.toBe(
      "# Topic\nCurrent understanding.",
    );
  });

  it("rejects traversal and symlink escapes", async () => {
    const { root, vault, provider } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(outside, path.join(vault, "escape"));

    const traversal = Effect.runPromise(provider.read("../outside/secret.md"));
    const escapedRead = Effect.runPromise(provider.read("escape/secret.md"));
    const escapedWrite = Effect.runPromise(provider.write("escape/new.md", "unsafe"));

    await expect(traversal).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "path-escape",
    });
    await expect(escapedRead).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "path-escape",
    });
    await expect(escapedWrite).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "path-escape",
    });
  });

  it("applies unique exact edits and leaves ambiguous or missing edits unchanged", async () => {
    const { vault, provider } = await fixture();
    const notePath = path.join(vault, "note.md");
    await writeFile(notePath, "alpha beta beta");

    await expect(
      Effect.runPromise(provider.edit("note.md", [{ oldText: "beta", newText: "gamma" }])),
    ).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "ambiguous-edit",
    });
    await expect(readFile(notePath, "utf8")).resolves.toBe("alpha beta beta");

    await expect(
      Effect.runPromise(provider.edit("note.md", [{ oldText: "missing", newText: "gamma" }])),
    ).rejects.toMatchObject({
      _tag: "NotesProviderError",
      code: "missing-edit",
    });
    await expect(readFile(notePath, "utf8")).resolves.toBe("alpha beta beta");

    await Effect.runPromise(
      provider.edit("note.md", [{ oldText: "alpha", newText: "delta" }], "\nappended"),
    );
    await expect(readFile(notePath, "utf8")).resolves.toBe("delta beta beta\nappended");
  });

  it("deletes note files without accepting directories", async () => {
    const { vault, provider } = await fixture();
    await writeFile(path.join(vault, "delete.md"), "remove me");
    await mkdir(path.join(vault, "directory.md"));

    await Effect.runPromise(provider.delete("delete.md"));

    await expect(Effect.runPromise(provider.read("delete.md"))).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(Effect.runPromise(provider.delete("directory.md"))).rejects.toBeInstanceOf(
      NotesProviderError,
    );
  });

  it("does not create a file when cancellation is already requested", async () => {
    const { vault, provider } = await fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      Effect.runPromise(provider.write("cancelled.md", "content"), { signal: controller.signal }),
    ).rejects.toBeDefined();
    await expect(readFile(path.join(vault, "cancelled.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
