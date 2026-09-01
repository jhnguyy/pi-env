# Notes extension

The extension registers a `notes` tool when Pi settings contain a `notes` block. It does not register the tool when the block is absent.

The first provider reads and writes a local Obsidian vault:

```json
{
  "notes": {
    "provider": "obsidian",
    "vaultPath": "/absolute/path/to/vault"
  }
}
```

Put machine-wide configuration in `~/.pi/agent/settings.json`. A trusted project can override it through `.pi/settings.json`.

The Obsidian provider exposes Markdown files only. It excludes hidden directories such as `.obsidian/` and `.trash/`. All tool paths are vault-relative. The provider rejects traversal and symlink escapes.

The vault must be on a trusted local filesystem. The provider does not defend against a privileged process that replaces verified directories during an operation. Cancellation prevents work before the atomic rename or delete commit point. A mutation can complete after cancellation reaches that commit point.

The tool supports `index`, `list`, `read`, `search`, `write`, `edit`, and `delete`. Mutations use atomic replacement. Exact edits fail without changing the note when text is absent or occurs more than once.
