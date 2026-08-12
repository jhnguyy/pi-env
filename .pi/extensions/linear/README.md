# Linear extension

The Linear extension adds explicit OAuth connection management and focused issue tools to Pi. The extension uses `@linear/sdk` behind an internal adapter.

## Connect

Run one of these commands:

- `/linear-auth login` starts a local loopback flow.
- `/linear-auth login --manual` asks you to paste the final callback URL. Use this mode for SSH, containers, and remote RPC clients.
- `/linear-auth login --write` requests `read` and `write` scopes. Login requests only `read` by default.

If no OAuth app configuration exists, Pi opens a partially completed private app form. Complete the app owner and homepage fields. Save the app, then paste its client ID into Pi.

The default callback is `http://127.0.0.1:43921/oauth/callback`. Use `--port <port>` when the OAuth app has another registered callback port. You can also set `LINEAR_OAUTH_CLIENT_ID` and `LINEAR_OAUTH_PORT` before Pi starts.

Linear API tools never start login. If no selected grant exists, a tool returns a machine-readable `auth_required` error.

## Connections

The extension supports multiple Linear organizations and users. Each connection records organization and viewer identity.

Use these commands:

- `/linear-auth status`
- `/linear-auth list`
- `/linear-auth use <connection>`
- `/linear-auth logout [connection]`
- `/linear-auth logout --all`

The first connection becomes the global default. A later login does not replace that default. Use `/linear-auth use` to change it.

Select a connection for one project in `.pi/settings.json`:

```json
{
  "linear": {
    "connection": "workspace-key/user@example.com"
  }
}
```

A trusted project setting overrides the global setting. You can use a connection ID, connection name, workspace key, user email, or `workspace-key/user@example.com`. Ambiguous selection fails before an API request.

## Storage

The extension separates non-secret configuration from rotating OAuth grants:

- `~/.pi/agent/linear/config.json` stores OAuth app and connection metadata.
- `~/.pi/agent/linear/credentials.json` stores access and refresh tokens.

The extension writes the directory with mode `0700` and both files with mode `0600`. Grant updates use atomic replacement and directory synchronization. Logout serializes with login and refresh operations. A stale operation cannot restore a removed grant.

## Tools

Read tools:

- `linear_viewer`
- `linear_list_resources`
- `linear_list_issues`
- `linear_search_issues`
- `linear_get_issue`

Write tools:

- `linear_create_issue`
- `linear_update_issue`
- `linear_create_comment`

`linear_list_resources` discovers teams, users, workflow states, projects, and labels. Read and write tools accept unique human names where practical. Ambiguous names return candidate data instead of selecting the first match.

List tools return at most 50 items and include `endCursor` when another page exists.

The tool manager automatically activates read tools for explicit Linear requests. Write tools are manual-only. Enable write tools with `/tools on linear-write` or an explicit profile. Every write checks the OAuth scope and opens an interactive preview for confirmation.

Issue and comment creation use stable client-generated IDs. A retry with the same idempotency key and payload does not create a second entity.

Pi marks a tool result as failed only when the tool throws. The extension therefore throws `LinearToolError` with a typed envelope and the same envelope encoded in `Error.message`. The envelope contains `code`, `message`, `retryable`, `recovery`, and optional `details` fields.

## SDK boundary

Only `sdk-adapter.ts` imports `@linear/sdk`. The extension pins SDK version `89.0.0` because its generated model and mutation contracts can change between SDK releases. Adapter contract tests must pass before the pin changes.
