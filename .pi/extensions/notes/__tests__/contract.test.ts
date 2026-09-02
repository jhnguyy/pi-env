import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  applyExactEdits,
  createNotesContract,
  MAX_DETAIL_ITEMS,
  NOTES_ACTIONS,
  NOTES_DESCRIPTION,
  NOTES_PARAMETERS,
} from "../contract";
import {
  MAX_EDIT_ITEMS,
  MAX_INDEX_BYTES,
  MAX_NOTE_BYTES,
  MAX_NOTE_COUNT,
  MAX_REVISION_LENGTH,
  type NoteSearchResult,
  type NotesProvider,
} from "../domain";

function provider(): NotesProvider {
  return {
    id: "test",
    index: vi.fn(async () => ({
      text: "[Notes Index]|provider:test",
      entries: [{ path: "anywhere/note.md" }],
    })),
    list: vi.fn(async () => [{ path: "anywhere/note.md" }]),
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

describe("notes tool contract", () => {
  it("exposes one stable provider-neutral schema", () => {
    const contract = createNotesContract(provider());
    expect(contract.name).toBe("notes");
    expect(contract.description).toBe(NOTES_DESCRIPTION);
    expect(contract.description).toContain("guarded write, edit, or delete");
    expect(contract.parameters).toBe(NOTES_PARAMETERS);
    for (const action of NOTES_ACTIONS) expect(Check(contract.parameters, { action })).toBe(true);
    expect(Check(contract.parameters, {})).toBe(false);
    expect(Check(contract.parameters, { action: "list", prefix: "any/provider/path" })).toBe(true);
    expect(Check(contract.parameters, { action: "list", area: "wiki" })).toBe(false);
    expect(Check(contract.parameters, { action: "search", areas: ["worklog"] })).toBe(false);
    expect(Check(contract.parameters, { action: "list", limit: MAX_NOTE_COUNT + 1 })).toBe(false);
    expect(
      Check(contract.parameters, {
        action: "edit",
        edits: Array.from({ length: MAX_EDIT_ITEMS + 1 }, () => ({ oldText: "a", newText: "b" })),
      }),
    ).toBe(false);
    expect(
      Check(contract.parameters, {
        action: "delete",
        revision: "r".repeat(MAX_REVISION_LENGTH + 1),
      }),
    ).toBe(false);
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
    expect(fake.list).toHaveBeenCalledWith({ prefix: "", limit: MAX_NOTE_COUNT }, undefined);
  });

  it("applies exact edits in the shell and writes with the read revision", async () => {
    const fake = provider();
    vi.mocked(fake.read).mockResolvedValue({
      path: "wiki/note.md",
      content: "alpha beta",
      revision: "rev-1",
    });
    const contract = createNotesContract(fake);
    const output = await contract.execute(
      {
        action: "edit",
        path: "wiki/note.md",
        revision: "rev-1",
        edits: [{ oldText: "beta", newText: "gamma" }],
        append: "\nmore",
      },
      { cwd: "/repo" },
    );
    expect(fake.write).toHaveBeenCalledWith(
      {
        path: "wiki/note.md",
        content: "alpha gamma\nmore",
        expectedRevision: "rev-1",
      },
      undefined,
    );
    expect(output.details.revision).toBe("rev-2");
  });

  it("rejects a stale edit before provider mutation", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);
    await expect(
      contract.execute(
        {
          action: "edit",
          path: "wiki/note.md",
          revision: "stale",
          edits: [{ oldText: "content", newText: "changed" }],
        },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fake.write).not.toHaveBeenCalled();
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
    vi.mocked(fake.list).mockResolvedValue(
      Array.from({ length: MAX_DETAIL_ITEMS + 50 }, (_, index) => ({ path: `${index}.md` })),
    );
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
    vi.mocked(fake.list).mockResolvedValue([
      { path: "wiki/oversized.md", size: MAX_NOTE_BYTES + 1 },
    ]);
    const contract = createNotesContract(fake);
    await expect(contract.execute({ action: "list" }, { cwd: "/repo" })).resolves.toMatchObject({
      details: { notes: [{ path: "wiki/oversized.md", size: MAX_NOTE_BYTES + 1 }] },
    });

    vi.mocked(fake.search).mockResolvedValue([
      { path: "wiki/one.md", extra: "must not escape" },
      { path: "wiki/two.md" },
    ] as unknown as readonly NoteSearchResult[]);
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

  it("requires explicit revision preconditions before mutation IO", async () => {
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
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.delete).not.toHaveBeenCalled();
  });
});
