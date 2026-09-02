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

## Shared contract

Every provider implements the complete Promise-based interface in `domain.ts`. The public entry point exports provider types, registration, canonical areas and path mappings, and canonical provider errors. The interface has no filesystem root, mutation queue, Effect type, capability negotiation, or provider-specific configuration.

`provider-registry.ts` owns the process-wide provider registry. It uses `Symbol.for("@pi-env/notes-providers")` so separate extension bundles share registrations regardless of load order. The selected provider is resolved when each tool call starts. Registration validates the complete baseline interface and rejects duplicate IDs.

The tool owns three canonical areas:

- `wiki` maps to `wiki/` and contains current knowledge.
- `worklog` maps to `records/worklog/` and contains dated events.
- `decisions` maps to `records/decisions/` and contains rationale.

Providers receive these areas as list and search filters. The tool owns their names, portable path validation, guidance, formatting, exact-edit behavior, and output limits. Read and resolve text includes the path and revision before the Markdown content so agents can perform guarded mutations.

The baseline provider operations are list, read, search, resolve, guarded write, and guarded delete. Reads return a revision. Creating a note requires a null revision precondition. Replacing, editing, or deleting a note requires the revision returned by read. Providers must check this precondition at their commit boundary and return a conflict when they detect a mismatch.

## Obsidian provider

The Obsidian provider exposes Markdown files only. It excludes hidden directories such as `.obsidian/` and `.trash/`. All tool paths are vault-relative. The provider rejects traversal, symbolic-link notes, and canonical targets in hidden metadata or non-Markdown files.

The vault must be on a trusted local filesystem. Mutations serialize on the canonical target. The provider checks file identity and content immediately before replace or delete. Creation uses an atomic hard link and cannot replace an existing path. Standard filesystem APIs cannot make revision comparison plus replacement atomic against an independent writer. An external writer can still change a path after the final check. Cancellation prevents work before the rename, link, or delete commit point. A mutation can complete after cancellation reaches that commit point.

Replacement preserves POSIX owner, group, and other permission bits. It does not promise to preserve ACLs or extended attributes. The provider limits note size, query size, result count, and vault inventory to bound local work.

The tool applies exact edits before a revision-guarded write. Exact edits fail without changing the note when text is absent or occurs more than once. The portable `agentic-notes` skill retains note-quality, rewrite, artifact, and privacy guidance that does not belong in the storage contract.
