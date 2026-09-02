import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  createNotesContract,
  MAX_DETAIL_ITEMS,
  NOTES_ACTIONS,
  NOTES_DESCRIPTION,
  NOTES_PARAMETERS,
} from "../contract";
import type { NotesProvider } from "../domain";

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
  });

  it("routes canonical areas and references through the provider", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);
    await contract.execute({ action: "index" }, { cwd: "/repo" });
    const listed = await contract.execute(
      { action: "list", area: "wiki", prefix: "wiki/ai" },
      { cwd: "/repo" },
    );
    await contract.execute({ action: "read", path: "wiki/note.md" }, { cwd: "/repo" });
    await contract.execute(
      { action: "search", query: "topic", areas: ["wiki", "decisions"], limit: 12 },
      { cwd: "/repo" },
    );
    const resolved = await contract.execute(
      { action: "resolve", reference: "worklog/today" },
      { cwd: "/repo" },
    );
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
