# Pi 0.99 adoption investigation

This page records which pi-env features overlap with Pi 0.99.1. It does not change runtime behavior. After the package upgrade, use `node_modules/@earendil-works/pi-coding-agent/docs/` as the Pi API authority. Use `package.json`, `.pi/extensions/`, and `setup/` as the pi-env implementation authority.

The package upgrade is a separate contribution. Do not remove a local boundary only because Pi uses a similar name. Test its input, authority, failure, and lifecycle contracts first.

## Tool orchestration

| Need | pi-env today | Pi 0.99.1 | Proposed direction |
| --- | --- | --- | --- |
| Batch tool calls and filter results | `ptc` runs a TypeScript/JavaScript body in a Node subprocess. Its RPC bridge returns plain text, limits calls and output, and dispatches built-ins and selected extension tools. | `codemode` runs JavaScript in QuickJS. It uses `ctx.executeTool()`, returns structured results when tools declare an output schema, limits output, and can call tools in parallel. | Prefer native `codemode` for main-session tool orchestration. Retain PTC only if a demonstrated workflow needs its Node/TypeScript subprocess or its child-agent contract. |
| Discover tools without declaring every tool to the model | `search_tools` activates tools by exact name, configured groups, or strong text matches. `tool-manager` restores a branch-specific profile and can activate groups from user input. | Built-in `tool_search` ranks undisclosed tools and declares selected tools. `codemode` also offers `searchTools()`, `describeTool()`, and `ALL_TOOLS`. `exposure` distinguishes `direct`, `codemode`, `deferred`, `model-only`, and `hidden`. | Replace the local `search_tools` tool. Do not keep two search tools by default. Set `codemode` or `deferred` exposure at registration for tools that discovery should hide. |
| Explicit tool policy | `/tools` manages profiles, groups, always-active tools, manual-only exclusions, and per-branch restoration. The current local configuration only sets `alwaysActive: ["notes"]`. | `defaultTools` accepts `+name` and `-name`. `tool_search` activates discovered tools on the current branch. Pi records declaration changes. Pi does not provide the local profile and input-trigger rules. | Test whether Pi's settings and exposure cover the actual `notes` requirement. Keep `/tools` or another small policy extension only for a requirement that remains after the test. |

**Interaction risk:** `tool-manager` restores its `core` profile on `session_start` and `session_tree`. Adding `+codemode` or `+tool_search` to `defaultTools` alone may not keep those tools active. Remove or revise the local profile owner as part of adoption. Built-in tools are registered but inactive by default. See Pi's `docs/cli.md#enable-codemode` and `docs/extensions.md#tool-exposure`.

**Safety and permission boundary:** Codemode itself grants no durable approval. It runs with the Pi process's operating-system access. Nested calls through `ctx.executeTool()` use Pi's validation and `tool_call` and `tool_result` handlers. A local permission extension can block or confirm them, but must own persistence of any approval. The local security extension redacts sensitive `read` results through `tool_result`. Test that redaction applies to nested results and structured content. Local subagents build separate `AgentTool` sets from capability labels. Codemode does not automatically inherit a child agent's narrower tool list or make child permissions persistent. The existing PTC dispatcher calls captured definitions directly and does not use Pi's nested-call pipeline.

Use `model-only` for tools that must be callable by the model but not from codemode. Before enabling codemode, classify orchestration and interactive tools such as `subagent`, `skill_build`, and `closeout`. Verify the resulting callable set, not only the active declarations. Preserve cancellation, progress, redaction, and bounded output for each supported tool path. A nonzero Bash exit is structured data (`exit_code` and `isError`), not an automatic JavaScript exception. Scripts must check it when later work depends on shell success.

**Adoption evidence required:**

1. Register a representative pi-env tool with `deferred` exposure. Run a real session with native `codemode` and `tool_search`. Verify discovery and execution without `search_tools` or PTC.
2. Verify that a blocked or interactive tool cannot be called from codemode. Verify that nested `read` results keep sensitive file content out of model output and session entries.
3. Compare a Bash nonzero exit, session environment, cancellation, tool progress, and output truncation in PTC and codemode. Verify how a dependent write is stopped or explicitly allowed.
4. Resume, fork, and change branches. Verify that tool declarations persist as intended and that the configured `notes` requirement holds without the local `core` profile.
5. Check whether any maintained child-agent workflow still needs PTC's Node subprocess, TypeScript input, or text-only RPC. Remove PTC only when the needed child contract has another owner.

## Themes

Pi 0.99.1 defaults to `system` when no `theme` setting exists. It derives colors from the terminal's foreground, background, and ANSI palette, adjusts contrast, and follows terminal appearance changes. It does not reproduce every color in a custom Pi theme. See Pi's `docs/themes.md` and `docs/tui.md`.

pi-env already sets light and dark Gruvbox palettes in `ghostty/config`. On a Ghostty host, `system` can follow those palettes without a bundled Pi palette. On another terminal, `system` follows that terminal instead of imposing Gruvbox. A custom Pi Gruvbox theme remains useful only when exact Pi-specific colors or portable Gruvbox appearance is a requirement.

`setup/managed-settings-core.mjs` currently writes `gruvbox-light/gruvbox-dark` when `theme` is absent. That setting overrides Pi's new default. Removing `themes` from the pi-env package manifest before changing setup would strand existing explicit Gruvbox selections. Do not silently rewrite user-selected themes.

**Proposed direction:** Let new setups omit `theme` so Pi selects `system`. Preserve existing `theme` values, including custom selections. Keep the Ghostty palettes as terminal configuration. Remove packaged Pi themes only after a migration path covers existing settings. Preview the result in light, dark, SSH, and terminals that do not report a palette. Compare contrast, tool status colors, and HTML exports before deciding whether an optional exact Gruvbox theme remains.

## Decision gate

This investigation favors native orchestration, discovery, and terminal-derived colors. It does not prove that PTC's child contract or an exact Gruvbox theme can be removed. Keep this decision open until the listed evidence exists. Keep the adoption PR in draft while these decisions are tested. Add removal, setup migration, and contract changes to that PR after the Pi package upgrade. Do not merge adoption behavior into the version-only PR.
