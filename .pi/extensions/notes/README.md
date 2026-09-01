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

Every provider implements the complete Promise-based interface in `domain.ts`. The interface has no filesystem root, mutation queue, Effect type, capability negotiation, or provider-specific configuration.

`provider-registry.ts` owns the process-wide provider registry. It uses `Symbol.for("@pi-env/notes-providers")` so separate extension bundles share registrations regardless of load order. The selected provider is resolved when each tool call starts. Registration validates the complete baseline interface and rejects duplicate IDs.

The tool owns three canonical areas:

- `wiki` maps to `wiki/` and contains current knowledge.
- `worklog` maps to `records/worklog/` and contains dated events.
- `decisions` maps to `records/decisions/` and contains rationale.

Providers receive these areas as list and search filters. The tool owns their names, paths, guidance, validation, formatting, exact-edit behavior, and output limits.

The baseline provider operations are list, read, search, resolve, guarded write, and guarded delete. Reads return a revision. Creating a note requires a null revision precondition. Replacing, editing, or deleting a note requires the revision returned by read. A mismatch fails with a conflict instead of overwriting newer content.

## Obsidian provider

The Obsidian provider exposes Markdown files only. It excludes hidden directories such as `.obsidian/` and `.trash/`. All tool paths are vault-relative. The provider rejects traversal and symlink escapes.

The vault must be on a trusted local filesystem. The provider does not defend against a privileged process that replaces verified directories during an operation. Cancellation prevents work before the atomic rename or delete commit point. A mutation can complete after cancellation reaches that commit point.

Mutations use atomic replacement and per-path serialization. The tool applies exact edits before a revision-guarded write. Exact edits fail without changing the note when text is absent or occurs more than once.
