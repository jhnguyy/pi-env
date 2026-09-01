import { Effect } from "effect";
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
    id: "obsidian",
    root: "/vault",
    index: vi.fn(() => Effect.succeed("index")),
    list: vi.fn(() => Effect.succeed([{ path: "note.md" }])),
    read: vi.fn(() => Effect.succeed("content")),
    search: vi.fn(() => Effect.succeed([{ path: "note.md", title: "Note" }])),
    write: vi.fn(() => Effect.void),
    edit: vi.fn(() => Effect.void),
    delete: vi.fn(() => Effect.void),
    queuePath: vi.fn((notePath: string) => `/vault/${notePath}`),
  };
}

describe("notes tool contract", () => {
  it("exposes one stable schema for all notes actions", () => {
    const contract = createNotesContract(provider());

    expect(contract.name).toBe("notes");
    expect(contract.description).toBe(NOTES_DESCRIPTION);
    expect(contract.parameters).toBe(NOTES_PARAMETERS);
    for (const action of NOTES_ACTIONS) expect(Check(contract.parameters, { action })).toBe(true);
    expect(Check(contract.parameters, {})).toBe(false);
    expect(Check(contract.parameters, { action: "resolve" })).toBe(false);
  });

  it("routes read actions through the provider", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);

    await contract.execute({ action: "index" }, { cwd: "/repo" });
    await contract.execute({ action: "list", prefix: "wiki/" }, { cwd: "/repo" });
    await contract.execute({ action: "read", path: "note.md" }, { cwd: "/repo" });
    await contract.execute({ action: "search", query: "topic" }, { cwd: "/repo" });

    expect(fake.index).toHaveBeenCalledOnce();
    expect(fake.list).toHaveBeenCalledWith("wiki/");
    expect(fake.read).toHaveBeenCalledWith("note.md");
    expect(fake.search).toHaveBeenCalledWith("topic");
  });

  it("bounds structured list details", async () => {
    const fake = provider();
    vi.mocked(fake.list).mockReturnValue(
      Effect.succeed(
        Array.from({ length: MAX_DETAIL_ITEMS + 50 }, (_, index) => ({ path: `${index}.md` })),
      ),
    );
    const contract = createNotesContract(fake);

    const output = await contract.execute({ action: "list" }, { cwd: "/repo" });

    expect(output.details.notes).toHaveLength(MAX_DETAIL_ITEMS);
    expect(output.details.truncated).toBe(true);
  });

  it("validates mutation inputs before provider IO", async () => {
    const fake = provider();
    const contract = createNotesContract(fake);

    await expect(
      contract.execute({ action: "write", path: "note.md" }, { cwd: "/repo" }),
    ).rejects.toThrow("notes write requires content");
    await expect(
      contract.execute({ action: "edit", path: "note.md" }, { cwd: "/repo" }),
    ).rejects.toThrow("notes edit requires edits or append");
    await expect(contract.execute({ action: "delete" }, { cwd: "/repo" })).rejects.toThrow(
      "notes delete requires path",
    );

    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.edit).not.toHaveBeenCalled();
    expect(fake.delete).not.toHaveBeenCalled();
  });
});
