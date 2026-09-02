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

## Progressive guidance

The active tool contributes model guidance through `promptGuidelines`. The guidance tells agents to orient with `index`, use `list` for authoritative inventory, read before mutation, choose exact edits or coherent rewrites deliberately, create durable notes only with a clear retrieval path, and keep secrets out of notes.

Each provider owns its bounded `index` response. The response explains store-specific organization and retrieval conventions only when an agent first needs them. The shared tool does not hard-code a vault taxonomy.

## Shared contract

Every provider implements the Promise-based interface in `domain.ts`. The public entry point exports provider types, registration, and canonical provider errors. The interface has no filesystem root, mutation queue, Effect type, artifact lifecycle, or provider-specific configuration.

`provider-registry.ts` owns the process-wide provider registry. It uses `Symbol.for("@pi-env/notes-providers")` so separate extension bundles share registrations. Providers in the same package can call `registerNotesProvider`. Independently bundled providers can emit `notes:provider:register` with `{ provider }` and respond to `notes:provider:discover`. The discovery handshake supports either extension load order without a runtime package import. The selected provider is resolved when each tool call starts. Registration validates the baseline interface and rejects duplicate IDs.

The required provider operations are bounded index, list, read, search, guarded write, and guarded delete. A provider can also implement reference resolution. The tool owns portable path validation, formatting, exact-edit behavior, revision preconditions, and output limits. Providers own storage or transport, store orientation, cancellation, mutation serialization, and commit-boundary conflict checks.

Reads return a revision. Creating a note requires a null revision precondition. Replacing, editing, or deleting a note requires the revision returned by read. The tool applies exact edits before a revision-guarded write. Exact edits fail without changing the note when text is absent or occurs more than once.

## Obsidian provider

The Obsidian provider exposes Markdown files only. It excludes hidden directories such as `.obsidian/` and `.trash/`. All tool paths are vault-relative. The provider rejects traversal, symbolic-link path segments, and canonical targets in hidden metadata or non-Markdown files.

The vault must be on a trusted local filesystem. Mutations serialize on the canonical target. The provider checks file identity and content immediately before replace or delete. Creation uses an atomic hard link and cannot replace an existing path. Standard filesystem APIs cannot make revision comparison plus replacement atomic against an independent writer. An external writer can still change a path after the final check.

Cancellation prevents work before the rename, link, or delete commit point. A mutation can complete after cancellation reaches that commit point. Replacement preserves the POSIX owner, group, permission bits, and special mode bits. It does not promise to preserve ACLs or extended attributes. The provider bounds note size, query size, result count, index orientation, and vault inventory.
