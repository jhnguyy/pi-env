# Linear extension

The Linear extension adds focused read-only Linear tools to Pi. The extension uses `@linear/sdk` behind an internal adapter and gets `linear.apiKey` from the provider-neutral credential source.

Configure the credential in the global Pi settings. See [`../credential-source/README.md`](../credential-source/README.md). Linear does not know whether 1Password or Bitwarden supplies the credential.

## Credential use

Linear tools do not ask for per-operation confirmation. Before credential retrieval, the gateway checks that `linear.apiKey` exists in the credential source. If it does not exist, the operation fails before it initializes the SDK or contacts Linear.

The adapter passes this credential to the Linear SDK as `apiKey`. It does not pass it as an OAuth `accessToken` or add a `Bearer` prefix.

## Tool

The `linear` tool routes read operations through its `action` parameter:

- `viewer`
- `list-resources`
- `list-issues`
- `search-issues`
- `get-issue`

The `list-resources` action discovers teams, users, workflow states, projects, and labels. Actions accept unique human names where practical. Ambiguous names return candidate data instead of selecting the first match.

List actions return at most 50 items and include `endCursor` when another page exists.

Pi marks a tool result as failed only when the tool throws. The extension therefore throws `LinearToolError` with a typed envelope. Credential failures map to `auth_required` with a sanitized credential error code in `details`.

Write tools are not available in this phase. Read-only use must complete security validation before writes return.

## SDK boundary

Only `sdk-adapter.ts` imports `@linear/sdk`. The extension pins SDK version `89.0.0` because its generated model and mutation contracts can change between SDK releases. Adapter contract tests must pass before the pin changes.

Resource queries use Linear server filters and server cursors. Tool output remains compact and bounded.
