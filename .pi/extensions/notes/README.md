# Notes extension

The extension registers one provider-neutral `notes` tool when settings contain a `notes` block. Without that block it registers nothing.

Select the built-in local Obsidian provider:

```json
{
  "notes": {
    "provider": "obsidian",
    "vaultPath": "/absolute/path/to/vault"
  }
}
```

Or select a provider registered by an adapter extension:

```json
{
  "notes": {
    "provider": "notes-assistant"
  }
}
```

Put machine-wide configuration in `~/.pi/agent/settings.json`. A trusted project can override it through `.pi/settings.json`.

## Provider-owned policy

The provider owns organization, destination contracts, and history policy. Pi-env supplies no collection helpers, fixed destination directories, templates, or archival rules. The tool supports `index`, `list`, `read`, `search`, `resolve`, `write`, `edit`, and `delete`. Omitting `collection` is preferred; `collection: "store"` remains a compatibility alias. Other collection values and `record` are no longer supported.

At `session_start`, after extension factories have registered their adapters, the extension resolves the configured provider and loads its bounded index. An optional index field identifies the policy entrypoint:

```ts
{ text: "Store orientation", policy: { path: "_meta/overview.md" } }
```

The extension uses ordinary `provider.read(path, signal)` to obtain complete content and its revision. External providers choose the path; the built-in Obsidian index advertises `_meta/overview.md` only when present in its inventory. Older providers without policy metadata can still serve reads.

The entrypoint must be nonblank and at most 16,384 UTF-8 bytes. The entire index-and-read load has a five-second deadline. Overflow fails rather than truncating policy. Only the entrypoint loads automatically, not linked contracts. Agent instructions require targeted retrieval of applicable destination contracts and inspection of the existing owner before writing.

Each model request receives request-local, lower-priority conversation context identifying the provider, path, revision, and policy content. This is untrusted guidance scoped to notes in that provider, not a system override, safety exemption, or permission grant. Policy is not appended to session history or reused from a prior session.

A new session or `/notes-reload` refreshes policy. Reload immediately invalidates the previous policy; there is no stale fallback. Missing metadata, missing files, malformed provider results, oversized content, read failure, cancellation, or timeout leave reads available and block `write`, `edit`, and `delete` until a successful load. Provider replacement also requires reloading. Failure warnings contain no remote error text. Loading signals abort on superseding reload, timeout, and shutdown. Providers must honor signals to stop their underlying IO; late results cannot publish policy after invalidation.

A successful load enables revision-guarded mutations; it does not mechanically enforce the remote document's prose. Refresh policy explicitly when changing contracts during a session.

## Shared provider contract

Providers implement the Promise-based interface in `domain.ts`. Index metadata is additive. List results carry bounded entries and an opaque continuation cursor; legacy terminal entry arrays remain supported. Reference resolution is optional. No policy-specific endpoint or configuration path is required.

The public entry point exports provider types, registration, and canonical provider errors. `provider-registry.ts` owns a process-wide registry using `Symbol.for("@pi-env/notes-providers")` so separate bundles share registrations. Providers in the same package can call `registerNotesProvider`. Independently bundled providers can emit `notes:provider:register` with `{ provider }` and respond to `notes:provider:discover`. The discovery handshake supports either factory load order without a runtime package import. Policy state belongs to one extension owner, not the registry.

The tool owns path validation, exact edits, revision preconditions, provider-result validation, and output limits. Providers own storage, transport, credentials, cancellation, mutation serialization, and commit-boundary conflicts.

Reads return a revision. Creating a note requires a null revision precondition. Replacing, editing, or deleting a note requires the revision returned by read. Exact edits fail without writing when text is absent or ambiguous.

## Obsidian safety

Only Markdown files are exposed. Hidden directories such as `.obsidian/` and `.trash/` are excluded. Paths are vault-relative; traversal, symbolic-link segments, and canonical targets in hidden metadata or non-Markdown files are rejected.

The vault must be on a trusted local filesystem. Mutations serialize on the canonical target and check file identity and content immediately before replace or delete. Creation uses an atomic hard link and cannot replace an existing path. Standard filesystem APIs cannot make revision comparison plus replacement atomic against an independent writer; an external writer can change a path after the final check.

Cancellation prevents work before the rename, link, or delete commit point. A mutation can complete after cancellation reaches that point. Replacement preserves POSIX owner, group, permission bits, and special mode bits, but not necessarily ACLs or extended attributes. The provider bounds note size, query size, result count, index orientation, and vault inventory.
