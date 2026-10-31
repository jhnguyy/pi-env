import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  applyExactEdits,
  createNotesContract,
  MAX_DETAIL_ITEMS,
  NOTES_ACTIONS,
  NOTES_PARAMETERS,
  NOTES_VARIANTS,
} from "../contract";
import {
  MAX_EDIT_ITEMS,
  MAX_INDEX_BYTES,
  MAX_LIST_CURSOR_LENGTH,
  MAX_NOTE_BYTES,
  MAX_NOTE_COUNT,
  MAX_REVISION_LENGTH,
  type NoteSearchResult,
  type NotesProvider,
} from "../domain";
import { vaultFixture } from "./vault-fixture";

// External-provider boundary cases include responses the Obsidian provider cannot produce.
function provider(): NotesProvider {
  return {
    id: "test",
    index: vi.fn(async () => ({
      text: "[Notes Index]|provider:test",
      entries: [{ path: "anywhere/note.md" }],
    })),
    list: vi.fn(async () => ({ entries: [{ path: "anywhere/note.md" }] })),
    read: vi.fn(async (path: string) => ({ path, content: "content", revision: "rev-1" })),
    search: vi.fn(async () => [{ path: "records/2026/09/01.md", title: "Record" }]),
    resolve: vi.fn(async () => ({
      path: "records/2026/09/01.md",
      content: "today",
      revision: "rev-today",
    })),
    write: vi.fn(async (request) => ({ path: request.path, revision: "rev-2" })),
    delete: vi.fn(async (request) => ({ path: request.path })),
  };
}

// Pi validates the flat declaration; execution then requires the matching variant.
const accepts = (value: unknown) => Check(NOTES_PARAMETERS, value) && Check(NOTES_VARIANTS, value);

describe("notes tool contract", () => {
  it("exposes a flat provider-neutral schema and rejects retired operations", async () => {
    const contract = createNotesContract(provider());
    expect(contract.name).toBe("notes");
    expect(NOTES_PARAMETERS.type).toBe("object");
    for (const field of Object.values(NOTES_PARAMETERS.properties))
      expect((field as { description?: string }).description).toBeTruthy();
    for (const action of NOTES_ACTIONS) expect(accepts({ action })).toBe(true);
    expect(accepts({ action: "list", collection: "store" })).toBe(true);
    for (const collection of ["inbox", "projects", "wiki", "worklog"]) {
      expect(accepts({ collection, action: "read" })).toBe(false);
      await expect(
        contract.execute({ collection, action: "read" } as never, { cwd: "/repo" }),
      ).rejects.toThrow();
    }
    expect(accepts({ action: "record" })).toBe(false);
    expect(accepts({})).toBe(false);
    expect(accepts({ action: "list", area: "wiki" })).toBe(false);
    expect(accepts({ action: "search", areas: ["worklog"] })).toBe(false);
    expect(accepts({ action: "list", limit: MAX_NOTE_COUNT + 1 })).toBe(false);
    expect(
      accepts({
        action: "edit",
        edits: Array.from({ length: MAX_EDIT_ITEMS + 1 }, () => ({ oldText: "a", newText: "b" })),
      }),
    ).toBe(false);
    expect(accepts({ action: "delete", revision: "r".repeat(MAX_REVISION_LENGTH + 1) })).toBe(
      false,
    );
  });

  it("uses provider-owned orientation and routes provider-neutral operations", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);
    await contract.execute({ action: "index" }, { cwd: "/repo" });
    const listed = await contract.execute(
      { action: "list", prefix: "projects/notes", limit: 12 },
      { cwd: "/repo" },
    );
    const read = await contract.execute(
      { action: "read", path: "records/2026/09/01.md" },
      { cwd: "/repo" },
    );
    await contract.execute({ action: "search", query: "topic", limit: 12 }, { cwd: "/repo" });
    const resolved = await contract.execute(
      { action: "resolve", reference: "record/by-date" },
      { cwd: "/repo" },
    );
    expect(read.content).toContainEqual({
      type: "text",
      text: expect.stringContaining('revision="rev-1"'),
    });
    expect(listed.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("under projects/notes"),
    });
    expect(fake.index).toHaveBeenCalledWith(undefined);
    expect(fake.list).toHaveBeenCalledWith({ prefix: "projects/notes", limit: 12 }, undefined);
    expect(fake.read).toHaveBeenCalledWith("records/2026/09/01.md", undefined);
    expect(fake.search).toHaveBeenCalledWith({ query: "topic", limit: 12 }, undefined);
    expect(fake.resolve).toHaveBeenCalledWith("record/by-date", undefined);
    expect(resolved.details).toMatchObject({
      path: "records/2026/09/01.md",
      revision: "rev-today",
    });
  });

  it("reports unsupported references without requiring every provider to implement resolve", async () => {
    const fake = provider();
    delete fake.resolve;
    const contract = createNotesContract(fake);
    await expect(
      contract.execute({ action: "resolve", reference: "daily/today" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "unsupported-reference" });
  });
  it("normalizes explicit empty inventory prefixes", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);
    await contract.execute({ action: "list", prefix: "./" }, { cwd: "/repo" });
    expect(fake.list).toHaveBeenCalledWith({ prefix: "", limit: MAX_DETAIL_ITEMS }, undefined);
  });

  it("creates, reads, edits, and deletes Store notes with persisted revision guards", async () => {
    const { provider: store, vault } = await vaultFixture();
    const contract = createNotesContract(store);
    const target = path.join(vault, "other/note.md");
    const created = await contract.execute(
      { action: "write", path: "other/note.md", content: "alpha beta", revision: null },
      { cwd: vault },
    );
    expect(await readFile(target, "utf8")).toBe("alpha beta");
    const read = await contract.execute({ action: "read", path: "other/note.md" }, { cwd: vault });
    expect(read.details.revision).toBe(created.details.revision);
    expect(read.content).toEqual([{ type: "text", text: expect.stringContaining("alpha beta") }]);
    expect(read.content).toEqual([
      { type: "text", text: expect.stringContaining(`revision="${read.details.revision}"`) },
    ]);
    const edited = await contract.execute(
      {
        action: "edit",
        path: "other/note.md",
        revision: read.details.revision,
        edits: [{ oldText: "beta", newText: "gamma" }],
        append: "\nalpha",
      },
      { cwd: vault },
    );
    expect(edited.content).toEqual([{ type: "text", text: "Edited other/note.md" }]);
    const persisted = await store.read("other/note.md");
    expect(persisted.revision).toBe(edited.details.revision);
    expect(persisted.revision).not.toBe(read.details.revision);
    expect(await readFile(target, "utf8")).toBe("alpha gamma\nalpha");

    await expect(
      contract.execute(
        {
          action: "edit",
          path: "other/note.md",
          revision: read.details.revision,
          append: "unsafe",
        },
        { cwd: vault },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    for (const [oldText, message] of [
      ["absent", "not found"],
      ["alpha", "more than once"],
    ]) {
      await expect(
        contract.execute(
          {
            action: "edit",
            path: "other/note.md",
            revision: persisted.revision,
            edits: [{ oldText, newText: "unsafe" }],
            append: "also unsafe",
          },
          { cwd: vault },
        ),
      ).rejects.toThrow(message);
      expect(await store.read("other/note.md")).toEqual(persisted);
    }
    await expect(
      contract.execute(
        {
          action: "delete",
          path: "other/note.md",
          revision: read.details.revision,
        },
        { cwd: vault },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(target, "utf8")).toBe(persisted.content);
    const deleted = await contract.execute(
      {
        action: "delete",
        path: "other/note.md",
        revision: persisted.revision,
      },
      { cwd: vault },
    );
    expect(deleted.content).toEqual([{ type: "text", text: "Deleted other/note.md" }]);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.read("other/note.md")).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects oversized provider orientation before exposing it", async () => {
    const fake = provider();
    vi.mocked(fake.index).mockResolvedValue({ text: "x".repeat(MAX_INDEX_BYTES + 1) });
    const contract = createNotesContract(fake);
    await expect(contract.execute({ action: "index" }, { cwd: "/repo" })).rejects.toMatchObject({
      code: "invalid-provider",
    });
    expect(fake.list).not.toHaveBeenCalled();
  });
  it("bounds structured list details", async () => {
    const fake = provider();
    vi.mocked(fake.list).mockResolvedValue({
      entries: Array.from({ length: MAX_DETAIL_ITEMS }, (_, index) => ({
        path: `${index}.md`,
      })),
      nextCursor: "next-page",
    });
    const contract = createNotesContract(fake);
    const output = await contract.execute({ action: "list" }, { cwd: "/repo" });
    expect(output.details.notes).toHaveLength(MAX_DETAIL_ITEMS);
    expect(output.details.truncated).toBe(true);
  });

  it("rejects unsafe paths and oversized UTF-8 content before provider IO", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);
    await expect(
      contract.execute({ action: "read", path: "../secret.md" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "path-escape" });
    await expect(
      contract.execute({ action: "read", path: "wiki/note.md/" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "not-a-note" });
    await expect(
      contract.execute({ action: "read", path: "@@note.md" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(
      contract.execute({ action: "read", path: "visible.txt:private.md" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(
      contract.execute({ action: "list", prefix: "/absolute" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(
      contract.execute(
        {
          action: "write",
          path: "wiki/large.md",
          content: "é".repeat(MAX_NOTE_BYTES),
          revision: null,
        },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "resource-limit" });
    expect(() =>
      applyExactEdits("x", [{ oldText: "x", newText: "é".repeat(MAX_NOTE_BYTES) }]),
    ).toThrow("exceeds");
    expect(() => applyExactEdits("aaa", [{ oldText: "aa", newText: "b" }])).toThrow(
      "more than once",
    );
    expect(fake.read).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("validates and limits external provider results", async () => {
    const fake = provider();
    vi.mocked(fake.list).mockResolvedValue({
      entries: [{ path: "wiki/oversized.md", size: MAX_NOTE_BYTES + 1 }],
    });
    const contract = createNotesContract(fake);
    await expect(contract.execute({ action: "list" }, { cwd: "/repo" })).resolves.toMatchObject({
      details: { notes: [{ path: "wiki/oversized.md", size: MAX_NOTE_BYTES + 1 }] },
    });

    const searchResults = [
      { path: "wiki/one.md", extra: "must not escape" },
      { path: "wiki/two.md" },
    ] satisfies readonly (NoteSearchResult & { readonly extra?: string })[];
    vi.mocked(fake.search).mockResolvedValue(searchResults);
    const search = await contract.execute(
      { action: "search", query: "topic", limit: 1 },
      { cwd: "/repo" },
    );
    expect(search.details.results).toEqual([{ path: "wiki/one.md" }]);

    vi.mocked(fake.read).mockResolvedValue({
      path: "../outside.md",
      content: "unsafe",
      revision: "revision",
    });
    await expect(
      contract.execute({ action: "read", path: "wiki/note.md" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "path-escape" });

    vi.mocked(fake.read).mockResolvedValue({
      path: "wiki/other.md",
      content: "wrong note",
      revision: "revision",
    });
    await expect(
      contract.execute({ action: "read", path: "wiki/note.md" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "invalid-provider" });

    vi.mocked(fake.write).mockResolvedValue({ path: "wiki/other.md", revision: "next" });
    await expect(
      contract.execute(
        { action: "write", path: "wiki/note.md", content: "content", revision: null },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "invalid-provider" });
  });

  it("requires explicit matching revision preconditions before mutation IO", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);
    await expect(
      contract.execute({ action: "write", path: "note.md", content: "content" }, { cwd: "/repo" }),
    ).rejects.toThrow("requires revision");
    await expect(
      contract.execute(
        { action: "edit", path: "note.md", edits: [{ oldText: "a", newText: "b" }] },
        { cwd: "/repo" },
      ),
    ).rejects.toThrow("requires the revision");
    await expect(
      contract.execute({ action: "delete", path: "note.md", revision: null }, { cwd: "/repo" }),
    ).rejects.toThrow("requires the revision");
    await expect(
      contract.execute({ action: "delete", path: "note.md", revision: "" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "invalid-revision" });
    // Obsidian also rejects stale writes; this boundary check proves the shell prevents write IO.
    await expect(
      contract.execute(
        { action: "edit", path: "note.md", revision: "stale", append: "unsafe" },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.delete).not.toHaveBeenCalled();
  });
});
