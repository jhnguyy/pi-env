# Tool Manager

Registers `search_tools` and `/tools` for soft tool availability management. Soft toggles only change which registered tools are offered to the model. They are not an authorization boundary.

## Settings

Configure the `toolManager` block in global or project `settings.json`:

- `defaultProfile`: profile used when the current branch has no saved state. The default is `core`.
- `profiles`: profile names mapped to tool or group names. Entries overlay the built-ins.
- `groups`: group names mapped to tool names. Entries overlay the built-ins.
- `alwaysActive`: registered tools that soft toggles cannot disable.
- `manualOnly`: tools excluded from `search_tools` and automatic input activation. Explicit `/tools on` and `/tools profile` commands may still activate them.
- `autoActivate`: enables high-confidence input-triggered activation. The default is `true`.

Built-in profiles are `core`, `coding`, and `full`. Built-in groups are `analysis`, `delegation`, `skills`, `catching-tests`, `sessions`, and `web`.

## Commands

- `/tools`: open the searchable selector in TUI mode, or show status in other modes.
- `/tools status`
- `/tools on <names...>`
- `/tools off <names...>`
- `/tools profile <name>`
- `/tools reset`

`search_tools` is always active and only adds tools.
