import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { applyExactEdits, createNotesContract, MAX_DETAIL_ITEMS, NOTES_ACTIONS } from "../contract";
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

describe("notes tool contract", () => {
  it("exposes one stable provider-neutral schema", () => {
    const contract = createNotesContract(provider());
    expect(contract.name).toBe("notes");
    const variants = contract.parameters.anyOf as Array<{
      properties: Record<string, { description?: string }>;
    }>;
    for (const variant of variants) {
      expect(variant.properties.collection?.description).toBeTruthy();
      expect(variant.properties.action.description).toBeTruthy();
    }
    for (const action of NOTES_ACTIONS.filter((candidate) => candidate !== "record")) {
      expect(Check(contract.parameters, { action })).toBe(true);
    }
    expect(Check(contract.parameters, { action: "record" })).toBe(false);
    expect(Check(contract.parameters, {})).toBe(false);
    expect(Check(contract.parameters, { action: "list", prefix: "any/provider/path" })).toBe(true);
    expect(Check(contract.parameters, { action: "list", area: "wiki" })).toBe(false);
    expect(Check(contract.parameters, { action: "search", areas: ["worklog"] })).toBe(false);
    expect(
      Check(contract.parameters, { collection: "inbox", action: "read", date: "2026-09-12" }),
    ).toBe(true);
    expect(Check(contract.parameters, { collection: "projects", action: "list" })).toBe(true);
    expect(
      Check(contract.parameters, {
        collection: "projects",
        action: "write",
        target: "platform/roadmap.md",
        content: "# Roadmap",
        revision: null,
      }),
    ).toBe(true);
    expect(Check(contract.parameters, { collection: "projects", action: "search" })).toBe(false);
    expect(
      Check(contract.parameters, { collection: "worklog", action: "record", text: "Shipped" }),
    ).toBe(true);
    expect(Check(contract.parameters, { collection: "wiki", action: "read", target: "ai" })).toBe(
      true,
    );
    expect(
      Check(contract.parameters, {
        collection: "inbox",
        action: "write",
        kind: "note",
        text: "capture",
        date: "2099-01-01",
      }),
    ).toBe(false);
    expect(
      Check(contract.parameters, {
        collection: "worklog",
        action: "record",
        text: "done",
        selector: "2000-01-01",
      }),
    ).toBe(false);
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

  it("reads Inbox items without mutation and preserves Follow-up state", async () => {
    const { provider: store, vault } = await vaultFixture({
      "inbox/20260901.md":
        "## Follow-ups\n\n- [x] done\n- [ ] open\n\n## Notes\n\n```md\n- hidden example\n```\n-\n- first note\n  - detail\n",
      "inbox/20260902.md": "## Notes\n\n- later note\n",
      "inbox/daily/2026/08/01.md": "## Notes\n\n- legacy\n",
      "inbox/2026/09/01.md": "## Notes\n\n- nested legacy\n",
      "inbox/2026/10/Untitled.md": "",
    });
    const contract = createNotesContract(store);
    const original = await store.read("inbox/20260901.md");

    const earliest = await contract.execute(
      { collection: "inbox", action: "read" },
      { cwd: "/repo" },
    );
    expect(earliest.details.items).toEqual([
      expect.objectContaining({
        date: "2026-09-01",
        kind: "followup",
        text: "done",
        checked: true,
        sourcePath: "inbox/20260901.md",
      }),
    ]);

    const dated = await contract.execute(
      { collection: "inbox", action: "read", date: "2026-09-01", limit: 10 },
      { cwd: "/repo" },
    );
    expect(dated.details.items).toEqual([
      expect.objectContaining({ kind: "followup", text: "done", checked: true }),
      expect.objectContaining({ kind: "followup", text: "open", checked: false }),
      expect.objectContaining({ kind: "note", text: "first note", nestedDetails: ["- detail"] }),
    ]);
    for (const text of ["first note", "- detail", '"checked": true', '"checked": false']) {
      expect(dated.content).toEqual([{ type: "text", text: expect.stringContaining(text) }]);
    }
    expect(await store.read("inbox/20260901.md")).toEqual(original);
    expect(await readFile(path.join(vault, "inbox/20260902.md"), "utf8")).toBe(
      "## Notes\n\n- later note\n",
    );
  });

  it("lists and reads only canonical Project documents with bounded cursors", async () => {
    const { provider: store } = await vaultFixture({
      "projects/alpha.md": "# Alpha",
      "projects/platform/roadmap.md": "# Platform roadmap",
      "projects-old.md": "not a project",
      "wiki/project.md": "wiki",
    });
    const contract = createNotesContract(store);

    const first = await contract.execute(
      { collection: "projects", action: "list", limit: 1 },
      { cwd: "/repo" },
    );
    expect(first.details.items).toEqual([
      expect.objectContaining({ target: "alpha.md", path: "projects/alpha.md" }),
    ]);
    expect(first.details.nextCursor).toEqual(expect.any(String));
    expect(first.content).toEqual([{ type: "text", text: expect.stringContaining("alpha.md") }]);

    const second = await contract.execute(
      {
        collection: "projects",
        action: "list",
        limit: 1,
        cursor: first.details.nextCursor,
      },
      { cwd: "/repo" },
    );
    expect(second.details.items).toEqual([
      expect.objectContaining({
        target: "platform/roadmap.md",
        path: "projects/platform/roadmap.md",
      }),
    ]);

    const read = await contract.execute(
      { collection: "projects", action: "read", target: "platform/roadmap.md" },
      { cwd: "/repo" },
    );
    expect(read.content).toEqual([
      { type: "text", text: expect.stringContaining("# Platform roadmap") },
    ]);
    expect(read.details).toMatchObject({
      collection: "projects",
      path: "projects/platform/roadmap.md",
      revision: expect.any(String),
    });
    await expect(
      contract.execute(
        { collection: "wiki", action: "read", cursor: first.details.nextCursor },
        { cwd: "/repo" },
      ),
    ).rejects.toThrow("mismatched");
  });

  it("returns schema-valid cursors for maximum UTF-8 Project targets", async () => {
    const target = `${("界".repeat(78) + "/").repeat(12)}${"界".repeat(64)}.md`;
    // This portable cursor limit exceeds some hosts' filesystem path limits.
    const external = provider();
    vi.mocked(external.list).mockResolvedValue({
      entries: [{ path: "projects/a.md" }, { path: `projects/${target}` }],
    });
    const contract = createNotesContract(external);

    const first = await contract.execute(
      { collection: "projects", action: "list", limit: 1 },
      { cwd: "/repo" },
    );
    const cursor = first.details.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    if (cursor === undefined) throw new Error("Expected a Project continuation cursor");
    expect(cursor.length).toBeGreaterThan(4_096);
    expect(
      Check(contract.parameters, {
        collection: "projects",
        action: "list",
        cursor,
      }),
    ).toBe(true);

    const second = await contract.execute(
      { collection: "projects", action: "list", cursor },
      { cwd: "/repo" },
    );
    expect(second.details.items).toEqual([expect.objectContaining({ target })]);
    expect(
      Check(contract.parameters, {
        collection: "projects",
        action: "list",
        cursor: "x".repeat(MAX_LIST_CURSOR_LENGTH + 1),
      }),
    ).toBe(false);
  });

  it("keeps Project writes under projects/ and requires revision preconditions", async () => {
    const { provider: store, vault } = await vaultFixture({ "projects/existing.md": "# Existing" });
    const contract = createNotesContract(store);
    const content =
      "# Existing\n\nOwner: Team\n\nStatus: active\n\n## Next actions\n\n- Ship\n\nTicket: T-1\n";
    const { revision } = await store.read("projects/existing.md");

    await contract.execute(
      {
        collection: "projects",
        action: "write",
        target: "existing.md",
        content,
        revision,
      },
      { cwd: "/repo" },
    );
    await contract.execute(
      {
        collection: "projects",
        action: "write",
        target: "nested/new.md",
        content: "Free-form active plan",
        revision: null,
      },
      { cwd: "/repo" },
    );

    expect(await readFile(path.join(vault, "projects/nested/new.md"), "utf8")).toBe(
      "Free-form active plan",
    );
    await expect(
      contract.execute(
        {
          collection: "projects",
          action: "write",
          target: "existing.md",
          content: "stale",
          revision,
        },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      contract.execute(
        { collection: "projects", action: "read", target: "../outside.md" },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "path-escape" });
    expect(await readFile(path.join(vault, "projects/existing.md"), "utf8")).toBe(content);
  });

  it("reads bounded Worklog selections in the requested date order", async () => {
    const { provider: store } = await vaultFixture({
      "records/2026/09/01.md": "## Worklog\n\n- first\n- second\n",
      "records/2026/09/02.md": "## Notes\n\n- not work\n",
      "records/2026/09/03.md": "## Worklog\n\n- third\n",
      "records/health/subject.md": "## Worklog\n\n- legacy subject record\n",
    });
    const contract = createNotesContract(store, { now: () => new Date(2026, 8, 3, 23, 30) });

    const firstPage = await contract.execute(
      { collection: "worklog", action: "read", selector: "all", limit: 2 },
      { cwd: "/repo" },
    );
    expect(firstPage.details.items).toEqual([
      expect.objectContaining({ date: "2026-09-03", text: "third" }),
      expect.objectContaining({ date: "2026-09-01", text: "first" }),
    ]);
    expect(firstPage.details.nextCursor).toEqual(expect.any(String));

    const secondPage = await contract.execute(
      {
        collection: "worklog",
        action: "read",
        selector: "all",
        limit: 2,
        cursor: firstPage.details.nextCursor,
      },
      { cwd: "/repo" },
    );
    expect(secondPage.details.items).toEqual([
      expect.objectContaining({ date: "2026-09-01", text: "second" }),
    ]);
    expect(secondPage.content).toEqual([{ type: "text", text: expect.stringContaining("second") }]);

    const chronological = await contract.execute(
      {
        collection: "worklog",
        action: "read",
        selector: "2026-09-01..2026-09-03",
        order: "chronological",
      },
      { cwd: "/repo" },
    );
    expect(chronological.details.items).toEqual([
      expect.objectContaining({ date: "2026-09-01", text: "first" }),
      expect.objectContaining({ date: "2026-09-01", text: "second" }),
      expect.objectContaining({ date: "2026-09-03", text: "third" }),
    ]);
    await expect(
      contract.execute(
        {
          collection: "worklog",
          action: "read",
          selector: "2026-09-01",
          cursor: firstPage.details.nextCursor,
        },
        { cwd: "/repo" },
      ),
    ).rejects.toThrow("mismatched");
  });

  it("binds collection continuation cursors to the original read scope", async () => {
    const { provider: store } = await vaultFixture({
      "inbox/20260901.md": "## Notes\n\n- one\n- two\n",
      "inbox/20260902.md": "## Notes\n\n- other date\n",
      "wiki/a.md": "a",
      "wiki/b.md": "b",
      "wiki/nested/c.md": "c",
    });
    const contract = createNotesContract(store);

    const inbox = await contract.execute(
      { collection: "inbox", action: "read", date: "2026-09-01", limit: 1 },
      { cwd: "/repo" },
    );
    expect(inbox.details.items).toEqual([expect.objectContaining({ text: "one" })]);
    expect(inbox.details.nextCursor).toEqual(expect.any(String));
    const continuedInbox = await contract.execute(
      {
        collection: "inbox",
        action: "read",
        date: "2026-09-01",
        limit: 1,
        cursor: inbox.details.nextCursor,
      },
      { cwd: "/repo" },
    );
    expect(continuedInbox.details.items).toEqual([expect.objectContaining({ text: "two" })]);
    await expect(
      contract.execute(
        {
          collection: "inbox",
          action: "read",
          date: "2026-09-02",
          cursor: inbox.details.nextCursor,
        },
        { cwd: "/repo" },
      ),
    ).rejects.toThrow("mismatched");

    const wiki = await contract.execute(
      { collection: "wiki", action: "read", limit: 1 },
      { cwd: "/repo" },
    );
    expect(wiki.details.nextCursor).toEqual(expect.any(String));
    const continuedWiki = await contract.execute(
      { collection: "wiki", action: "read", limit: 1, cursor: wiki.details.nextCursor },
      { cwd: "/repo" },
    );
    expect(continuedWiki.details.items).toHaveLength(1);
    await expect(
      contract.execute(
        { collection: "wiki", action: "read", target: "nested", cursor: wiki.details.nextCursor },
        { cwd: "/repo" },
      ),
    ).rejects.toThrow("mismatched");
  });

  it("continues Worklog reads after the per-call document budget", async () => {
    const records = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => {
        const path =
          index < 31
            ? `records/2026/01/${String(index + 1).padStart(2, "0")}.md`
            : "records/2026/02/01.md";
        return [path, "## Notes\n\n- no Worklog\n"];
      }),
    );
    records["records/2026/02/02.md"] = "## Worklog\n\n- found\n";
    const { provider: store } = await vaultFixture(records);
    const contract = createNotesContract(store);

    const first = await contract.execute(
      { collection: "worklog", action: "read", selector: "all", order: "chronological" },
      { cwd: "/repo" },
    );
    expect(first.details.items).toEqual([]);
    expect(first.details.nextCursor).toEqual(expect.any(String));

    const second = await contract.execute(
      {
        collection: "worklog",
        action: "read",
        selector: "all",
        order: "chronological",
        cursor: first.details.nextCursor,
      },
      { cwd: "/repo" },
    );
    expect(second.details.items).toEqual([expect.objectContaining({ text: "found" })]);
  });

  it("continues before structured collection details exceed their byte budget", async () => {
    const firstText = "a".repeat(20_000);
    const secondText = "b".repeat(20_000);
    const { provider: store } = await vaultFixture({
      "records/2026/09/01.md": `## Worklog\n\n- ${firstText}\n- ${secondText}\n`,
    });
    const contract = createNotesContract(store);

    const first = await contract.execute(
      { collection: "worklog", action: "read", selector: "2026-09-01" },
      { cwd: "/repo" },
    );
    expect(first.content).toEqual([{ type: "text", text: expect.stringContaining(firstText) }]);
    expect(first.details.items).toEqual([expect.objectContaining({ text: firstText })]);
    expect(first.details.nextCursor).toEqual(expect.any(String));
    const second = await contract.execute(
      {
        collection: "worklog",
        action: "read",
        selector: "2026-09-01",
        cursor: first.details.nextCursor,
      },
      { cwd: "/repo" },
    );
    expect(second.content).toEqual([{ type: "text", text: expect.stringContaining(secondText) }]);
    expect(second.details.items).toEqual([expect.objectContaining({ text: secondText })]);
  });

  it("navigates Wiki folders without recursively flooding their results", async () => {
    const initial = {
      "wiki/root.md": "root",
      "wiki/ai/one.md": "one",
      "wiki/ai/nested/two.md": "two",
      "wiki/food/recipe.md": "recipe",
    };
    const { provider: store, vault } = await vaultFixture(initial);
    const contract = createNotesContract(store);

    const root = await contract.execute({ collection: "wiki", action: "read" }, { cwd: "/repo" });
    expect(root.details.items).toEqual([
      expect.objectContaining({ kind: "folder", target: "ai" }),
      expect.objectContaining({ kind: "folder", target: "food" }),
      expect.objectContaining({ kind: "file", target: "root.md" }),
    ]);

    const folder = await contract.execute(
      { collection: "wiki", action: "read", target: "ai" },
      { cwd: "/repo" },
    );
    expect(folder.details.items).toEqual([
      expect.objectContaining({ kind: "folder", target: "ai/nested" }),
      expect.objectContaining({ kind: "file", target: "ai/one.md" }),
    ]);

    const file = await contract.execute(
      { collection: "wiki", action: "read", target: "ai/one.md" },
      { cwd: "/repo" },
    );
    expect(file.details).toMatchObject({ path: "wiki/ai/one.md", revision: expect.any(String) });
    expect(file.content).toEqual([{ type: "text", text: expect.stringContaining("\none") }]);
    for (const [notePath, content] of Object.entries(initial)) {
      expect(await readFile(path.join(vault, notePath), "utf8")).toBe(content);
    }
  });

  it("uses the process-local date for collection writes and preserves other sections", async () => {
    const { provider: store, vault } = await vaultFixture({
      "inbox/20260912.md":
        "# Context\r\n\r\n```md\r\n## Follow-ups\r\n- [ ]\r\n```\r\n\r\n## Follow-ups\r\n\r\n- [ ]\r\n\r\n## Notes\r\n\r\n- old\r\n\r\n## Other\r\n\r\nkeep\r\n",
      "inbox/2026/09/12.md": "## Notes\n\n- nested legacy\n",
      "records/2026/09/12.md": "---\ntype: record\n---\n# Record\n\n## Decisions\n\nkeep\n",
    });
    const contract = createNotesContract(store, { now: () => new Date(2026, 8, 12, 23, 59) });

    await contract.execute(
      { collection: "inbox", action: "write", kind: "followup", text: "new task" },
      { cwd: "/repo" },
    );
    await contract.execute(
      { collection: "worklog", action: "record", text: "Shipped the contract" },
      { cwd: "/repo" },
    );

    expect(await readFile(path.join(vault, "inbox/20260912.md"), "utf8")).toBe(
      "# Context\r\n\r\n```md\r\n## Follow-ups\r\n- [ ]\r\n```\r\n\r\n## Follow-ups\r\n\r\n- [ ] new task\r\n\r\n## Notes\r\n\r\n- old\r\n\r\n## Other\r\n\r\nkeep\r\n",
    );
    expect(await readFile(path.join(vault, "inbox/2026/09/12.md"), "utf8")).toBe(
      "## Notes\n\n- nested legacy\n",
    );
    expect(await readFile(path.join(vault, "records/2026/09/12.md"), "utf8")).toContain(
      "## Decisions\n\nkeep\n\n## Worklog\n\n- Shipped the contract\n",
    );
    await expect(stat(path.join(vault, "inbox/20260913.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a collection append that would exceed the note byte limit", async () => {
    const notePath = "inbox/20260912.md";
    const prefix = "## Notes\n\n- ";
    const original = prefix + "x".repeat(MAX_NOTE_BYTES - prefix.length);
    const { provider: store, vault } = await vaultFixture({ [notePath]: original });
    const contract = createNotesContract(store, { now: () => new Date(2026, 8, 12) });

    await expect(
      contract.execute(
        { collection: "inbox", action: "write", kind: "note", text: "overflow" },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "resource-limit" });
    expect(await readFile(path.join(vault, notePath), "utf8")).toBe(original);
  });

  it("rejects a concurrent Inbox append without replacing the newer content", async () => {
    const notePath = "inbox/20260912.md";
    const { provider: store, vault } = await vaultFixture(
      { [notePath]: "## Notes\n\n- current\n" },
      {
        beforeCommit: async (target) => {
          await writeFile(target, "## Notes\n\n- concurrent\n");
        },
      },
    );
    const contract = createNotesContract(store, { now: () => new Date(2026, 8, 12) });

    await expect(
      contract.execute(
        { collection: "inbox", action: "write", kind: "note", text: "unsafe append" },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path.join(vault, notePath), "utf8")).toBe("## Notes\n\n- concurrent\n");
  });

  it("requires guarded Wiki creation and updates", async () => {
    const { provider: store, vault } = await vaultFixture({ "wiki/existing.md": "old" });
    const contract = createNotesContract(store);

    await contract.execute(
      {
        collection: "wiki",
        action: "write",
        target: "new.md",
        content: "new",
        revision: null,
      },
      { cwd: "/repo" },
    );
    await expect(
      contract.execute(
        {
          collection: "wiki",
          action: "write",
          target: "existing.md",
          content: "unconditional overwrite",
          revision: null,
        },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path.join(vault, "wiki/existing.md"), "utf8")).toBe("old");

    const { revision } = await store.read("wiki/existing.md");
    await contract.execute(
      {
        collection: "wiki",
        action: "write",
        target: "existing.md",
        content: "updated",
        revision,
      },
      { cwd: "/repo" },
    );
    await expect(
      contract.execute(
        {
          collection: "wiki",
          action: "write",
          target: "existing.md",
          content: "stale",
          revision,
        },
        { cwd: "/repo" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path.join(vault, "wiki/existing.md"), "utf8")).toBe("updated");
    for (const target of ["/outside.md", "nested//note.md", "nested/note.md/"]) {
      await expect(
        contract.execute(
          { collection: "wiki", action: "write", target, content: "unsafe", revision: null },
          { cwd: "/repo" },
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/invalid-path|path-escape/) });
    }
    await expect(stat(path.join(vault, "wiki/nested/note.md"))).rejects.toMatchObject({
      code: "ENOENT",
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
