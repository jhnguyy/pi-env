# Notes extension

The extension registers one cross-host `notes` tool when Pi settings contain a `notes` block. It does not register the tool when the block is absent.

Select a provider by ID. The built-in provider reads and writes a local Obsidian vault:

```json
{
  "notes": {
    "provider": "obsidian",
    "vaultPath": "/absolute/path/to/vault"
  }
}
```

An external extension can register a provider such as `notes-assistant`, then select it without Obsidian settings:

```json
{
  "notes": {
    "provider": "notes-assistant"
  }
}
```

Put machine-wide configuration in `~/.pi/agent/settings.json`. A trusted project can override it through `.pi/settings.json`.

## Collection behavior

Pi-env owns the portable Inbox, Worklog, and Wiki lifecycle. Providers remain storage-neutral and own storage, transport, credentials, revisions, conflicts, and commit behavior.

### Inbox

Inbox notes use `inbox/YYYY/MM/DD.md`. An Inbox read without a date returns the earliest nonblank item. A dated read returns Notes and Follow-ups from that date. Results include Follow-up checked state. Reads never mutate note content.

An Inbox write records one Note or unchecked Follow-up for the Pi process system-local date. It creates the daily note or exact level-two section when needed and preserves unrelated content.

### Worklog

Worklog items are brief completed-work bullets under `## Worklog` in `records/YYYY/MM/DD.md`. Recording always uses the Pi process system-local date. Reads support today, an exact ISO date, an inclusive `start..end` range, or `all`. They default to newest-date-first order and can request chronological order.

### Wiki

Wiki targets are relative to `wiki/`. A read without a target lists immediate root children. A folder target lists immediate child folders and Markdown files. A Markdown file target returns its content and revision. Wiki writes require a null revision for explicit creation or the revision returned by a prior read for update.

All collection list results are bounded. A returned opaque cursor continues the same selection. Do not reuse a cursor with a different collection, selector, target, or order.

## Store compatibility

Omit `collection` or select `store` to use the provider-neutral `index`, `list`, `read`, `search`, `resolve`, `write`, `edit`, and `delete` operations. These actions remain available for orientation, global search, legacy and adapter-owned notes, and bounded migration work. Use collection actions for new Inbox, Worklog, and Wiki writes.

Each provider supplies a bounded index response for store-specific orientation. Use list as the authoritative inventory when working outside the core collections.

## Shared provider contract

Every provider implements the Promise-based interface in `domain.ts`. List results carry bounded entries and an opaque provider continuation cursor. Existing providers that return one terminal entry array remain compatible while they adopt pagination. The public entry point exports provider types, registration, and canonical provider errors. The interface has no filesystem root, mutation queue, Effect type, note taxonomy, or provider-specific configuration.

`provider-registry.ts` owns the process-wide provider registry. It uses `Symbol.for("@pi-env/notes-providers")` so separate extension bundles share registrations. Providers in the same package can call `registerNotesProvider`. Independently bundled providers can emit `notes:provider:register` with `{ provider }` and respond to `notes:provider:discover`. The discovery handshake supports either extension load order without a runtime package import. The selected provider is resolved when each tool call starts.

The required provider operations are bounded index, list, read, search, guarded write, and guarded delete. A provider can also implement reference resolution. The tool owns portable collection behavior, path validation, formatting, exact edits, revision preconditions, provider-result validation, and output limits. Providers own storage or transport, cancellation, mutation serialization, and commit-boundary conflict checks.

Reads return a revision. Creating a note requires a null revision precondition. Replacing, editing, or deleting a note requires the revision returned by read. The tool applies exact edits before a revision-guarded write. Exact edits fail without changing the note when text is absent or occurs more than once.

## Obsidian provider

The Obsidian provider exposes Markdown files only. It excludes hidden directories such as `.obsidian/` and `.trash/`. All tool paths are vault-relative. The provider rejects traversal, symbolic-link path segments, and canonical targets in hidden metadata or non-Markdown files.

The vault must be on a trusted local filesystem. Mutations serialize on the canonical target. The provider checks file identity and content immediately before replace or delete. Creation uses an atomic hard link and cannot replace an existing path. Standard filesystem APIs cannot make revision comparison plus replacement atomic against an independent writer. An external writer can still change a path after the final check.

Cancellation prevents work before the rename, link, or delete commit point. A mutation can complete after cancellation reaches that commit point. Replacement preserves the POSIX owner, group, permission bits, and special mode bits. It does not promise to preserve ACLs or extended attributes. The provider bounds note size, query size, result count, index orientation, and vault inventory.
