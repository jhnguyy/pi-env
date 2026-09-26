# Linear extension

The Linear extension adds one Linear tool for reading and writing tickets in Pi. The extension uses `@linear/sdk` behind an internal adapter and gets `linear.apiKey` from the provider-neutral credential source.

Configure the credential in the global Pi settings. See [`../credential-source/README.md`](../credential-source/README.md). Linear does not know whether 1Password or Bitwarden supplies the credential.

## Credential use

Linear writes do not ask for per-operation confirmation. The configured API key and Linear account permissions govern which tickets can change. A write can affect any issue that the account can access; it is not limited to issues assigned to the viewer. Before credential retrieval, the gateway checks that `linear.apiKey` exists in the credential source. If it does not exist, the operation fails before it initializes the SDK or contacts Linear.

The adapter passes this credential to the Linear SDK as `apiKey`. It does not pass it as an OAuth `accessToken` or add a `Bearer` prefix.

## Tool

Select `collection` first, then `action`:

| Collection | Actions |
| --- | --- |
| `viewer` | `read` |
| `resources` | `list` (requires `resourceType`) |
| `issues` | `list`, `search`, `read`, `create`, `update` |
| `comments` | `create` |

For example, `{ "collection": "issues", "action": "update", "issueId": "ENG-1", "title": "New title" }` changes one field. Issue creation requires `team` and `title`. Comment creation requires `issueId` and `body`. Updates require at least one change. A null `assignee`, `project`, or `dueDate` clears that field on update. `labels` replaces the full label set. An empty array clears all labels. Other omitted fields remain unchanged. Read an issue before editing it to confirm its current state. Linear updates do not have a revision precondition, so concurrent changes to the same field can overwrite each other.

The former read actions (`viewer`, `list-resources`, `list-issues`, `search-issues`, `get-issue`) remain available without a `collection` for compatibility. New calls should use `collection` and `action`.

The `list-resources` action discovers teams, users, workflow states, projects, and labels. Actions accept unique human names where practical. Ambiguous names return candidate data instead of selecting the first match.

List actions return at most 50 items and include `endCursor` when another page exists.

Pi marks a tool result as failed only when the tool throws. The extension therefore throws `LinearToolError` with a typed envelope. Credential failures map to `auth_required` with a sanitized credential error code in `details`.

The tool has read and write capabilities for cross-host selection. Read-only subagents cannot select it by the read capability alone. Local tests use a stub SDK client. They do not contact Linear. If an update fails after it reaches Linear, check the ticket before retrying. Its final state can be uncertain.

## SDK boundary

Only `sdk-adapter.ts` imports `@linear/sdk`. The extension pins SDK version `89.0.0` because its generated model and mutation contracts can change between SDK releases. Adapter contract tests must pass before the pin changes.

Resource queries use Linear server filters and server cursors. Tool output remains compact and bounded.
