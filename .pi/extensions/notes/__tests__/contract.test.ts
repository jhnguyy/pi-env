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
import { MAX_EDIT_ITEMS, MAX_NOTE_BYTES, MAX_REVISION_LENGTH, type NotesProvider } from "../domain";

function provider(): NotesProvider {
  return {
    id: "test",
    list: vi.fn(async () => [{ path: "wiki/note.md" }]),
    read: vi.fn(async (path: string) => ({ path, content: "content", revision: "rev-1" })),
    search: vi.fn(async () => [{ path: "wiki/note.md", title: "Note" }]),
    resolve: vi.fn(async () => ({
      path: "records/worklog/2026/09/01.md",
      content: "today",
      revision: "rev-today",
    })),
    write: vi.fn(async (request) => ({ path: request.path, revision: "rev-2" })),
    delete: vi.fn(async (request) => ({ path: request.path })),
  };
}

describe("notes tool contract", () => {
  it("exposes one stable schema with canonical note areas", () => {
    const contract = createNotesContract(provider());
    expect(contract.name).toBe("notes");
    expect(contract.description).toBe(NOTES_DESCRIPTION);
    expect(contract.description).toContain("Never store secrets");
    expect(contract.parameters).toBe(NOTES_PARAMETERS);
    for (const action of NOTES_ACTIONS) expect(Check(contract.parameters, { action })).toBe(true);
    expect(Check(contract.parameters, {})).toBe(false);
    expect(Check(contract.parameters, { action: "list", area: "wiki" })).toBe(true);
    expect(Check(contract.parameters, { action: "search", areas: ["worklog", "decisions"] })).toBe(
      true,
    );
    expect(Check(contract.parameters, { action: "list", area: "projects" })).toBe(false);
    expect(Check(contract.parameters, { action: "search", query: "x", limit: 101 })).toBe(false);
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

  it("routes canonical areas and references through the provider", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);
    await contract.execute({ action: "index" }, { cwd: "/repo" });
    const listed = await contract.execute(
      { action: "list", area: "wiki", prefix: "wiki/ai" },
      { cwd: "/repo" },
    );
    const read = await contract.execute({ action: "read", path: "wiki/note.md" }, { cwd: "/repo" });
    await contract.execute(
      { action: "search", query: "topic", areas: ["wiki", "decisions"], limit: 12 },
      { cwd: "/repo" },
    );
    const resolved = await contract.execute(
      { action: "resolve", reference: "worklog/today" },
      { cwd: "/repo" },
    );
    expect(read.content).toContainEqual({
      type: "text",
      text: expect.stringContaining('revision="rev-1"'),
    });
    expect(listed.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("in wiki and under wiki/ai"),
    });
    expect(fake.list).toHaveBeenNthCalledWith(1, {}, undefined);
    expect(fake.list).toHaveBeenNthCalledWith(2, { area: "wiki", prefix: "wiki/ai" }, undefined);
    expect(fake.read).toHaveBeenCalledWith("wiki/note.md", undefined);
    expect(fake.search).toHaveBeenCalledWith(
      { query: "topic", areas: ["wiki", "decisions"], limit: 12 },
      undefined,
    );
    expect(fake.resolve).toHaveBeenCalledWith("worklog/today", undefined);
    expect(resolved.details).toMatchObject({
      path: "records/worklog/2026/09/01.md",
      revision: "rev-today",
    });
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
    vi.mocked(fake.search).mockResolvedValue([{ path: "wiki/one.md" }, { path: "wiki/two.md" }]);
    const contract = createNotesContract(fake);
    const search = await contract.execute(
      { action: "search", query: "topic", limit: 1 },
      { cwd: "/repo" },
    );
    expect(search.details.results).toHaveLength(1);

    vi.mocked(fake.read).mockResolvedValue({
      path: "../outside.md",
      content: "unsafe",
      revision: "revision",
    });
    await expect(
      contract.execute({ action: "read", path: "wiki/note.md" }, { cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "path-escape" });
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
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.delete).not.toHaveBeenCalled();
  });
});
