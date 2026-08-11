# Linear extension

The Linear extension adds OAuth authentication and focused issue tools to Pi. The extension uses `@linear/sdk` for API operations.

## Authentication

Run `/linear-auth login` to connect a workspace. A Linear tool also starts login when no credentials exist in TUI or RPC mode.

If no OAuth client ID exists, the login flow does these steps:

1. It opens a prefilled private OAuth app form.
2. It asks for the saved app client ID.
3. It opens the OAuth consent page.
4. It receives the callback on `http://127.0.0.1:43921/oauth/callback`.

The flow uses authorization code grant with S256 Proof Key for Code Exchange (PKCE). It requests `read` and `write` scopes. It does not use a client secret.

Set these optional environment variables before Pi starts:

- `LINEAR_OAUTH_CLIENT_ID`: Reuse an existing OAuth app.
- `LINEAR_OAUTH_PORT`: Change the callback port. Register the matching callback URI in the OAuth app.

In print or JSON mode, tools do not start an interactive login. The tool error tells the user to run `/linear-auth login` in TUI or RPC mode.

Use these commands:

- `/linear-auth status`
- `/linear-auth login`
- `/linear-auth logout`

The extension stores rotating access and refresh tokens in `~/.pi/agent/linear/credentials.json`. It writes the directory with mode `0700` and the file with mode `0600`. It refreshes access tokens before expiry. Logout attempts remote revocation and always removes the local file.

## Tools

- `linear_viewer`
- `linear_list_issues`
- `linear_search_issues`
- `linear_get_issue`
- `linear_create_issue`
- `linear_update_issue`
- `linear_create_comment`

List and search tools return at most 50 issues. Mutation tools return concise entity data.
