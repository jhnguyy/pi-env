# Optional Atuin client

This integration enables shell history, terminal output, native Pi thread capture (including tool input/output), and Pi's native MCP server registration. It does not deploy a sync server, create an account, log in, import history or sessions, run sync, or start/restart a daemon during setup. Normal pi-env setup does not enable it.

**Privacy:** enabling capture can retain conversations, code, commands, and terminal output. Native thread capture includes other supported coding agents, not only Pi. Atuin's filters and redaction are best-effort, not a security boundary. Review [Atuin's exclusions](https://docs.atuin.sh/guide/excluding-commands/) before enabling capture. After login, history and threads sync to your selected server with Atuin's encrypted record sync. **Captured shell output stays local in v18.24.6; it does not sync.** MCP exposes local history, output, and threads to Pi across projects.

## Command contract

Requires Node meeting [pi-env's runtime requirements](../package.json), Bash, and `curl`/`tar` for portable installation. Supported release artifacts: Linux x86_64/aarch64 (static musl) and macOS x86_64/aarch64. Linux x86_64 is locally qualified; other platforms require native qualification.

From the checkout, replace the URL with your server's base URL:

```bash
ATUIN_HOME="$HOME/.local/share/atuin/personal" node scripts/setup-atuin.mjs \
  --sync-url https://history.example.net \
  --portable --shell bash
```

Use `--shell zsh` for Zsh, or `--shell none` to leave profiles alone. Both interactive shell fragments are always generated. Hooks invoke `atuin init <shell> --disable-ai`: Atuin's AI command-generation bindings remain disabled; thread capture and MCP remain enabled. Native initialization starts the PTY proxy, and history hooks autostart the daemon. Open a new shell after setup. If a daemon already runs, restart it explicitly through the generated wrapper after setup to apply capture changes.

`--portable` installs the pinned CLI in `${PI_BIN_DIR:-$HOME/.local/bin}`. An existing matching version is reused; another version at that location is replaced. Downloads use the official release artifact and the pinned SHA-256 in [the release manifest](../setup/atuin-release.json), not a mutable installer. `--atuin /absolute/path/to/atuin` uses an explicitly provisioned CLI instead, without downloading. Windows and shells other than Bash/Zsh are not supported by this command.

For externally Nix-managed tools:

```bash
ATUIN_HOME="$HOME/.local/share/atuin/personal" node scripts/setup-atuin.mjs \
  --sync-url https://history.example.net \
  --nix-managed --shell bash
```

`--nix-managed` requires the pinned CLI on `PATH` (or `--atuin`). It never installs a CLI or edits shell profiles, regardless of `--shell`. The exported `packages.<system>.atuin`, `tools`, and `toolchain` supply the pinned release independently of nixpkgs' Atuin version. Installing the toolchain alone does not enable capture. Portable profile edits are rejected when `PI_ENV_CONFIG_MANAGED_BY_NIX=1`.

The provisioner owns sourcing the generated `init.bash` or `init.zsh` from its interactive shell configuration; do not also enable another Atuin shell integration. For example, with the default Pi agent directory:

```bash
. "$HOME/.pi/agent/atuin/init.bash"
```

The command returns zero on success and nonzero on invalid arguments, incompatible CLI/capabilities, or configuration failure. It requires an explicit HTTP(S) URL without credentials, query, or fragment, exactly one mode, and an explicit shell choice. Prefer HTTPS for remote servers. Exit zero means configuration is prepared, not that authentication, capture, or server connectivity has been validated.

## State and ownership

`PI_CODING_AGENT_DIR` selects Pi state; the legacy `PI_AGENT_DIR` alias follows the [existing resolver](../setup/agent-dir.sh). Conflicting selections fail. Setup updates only `mcpServers.atuin` in that directory's `mcp.json`; it preserves existing exposure/enabled choices, other servers, and top-level keys and never edits Pi's `settings.json`. A conflicting external registration under that name fails before capture configuration changes. Restart Pi to load MCP.

An explicit absolute `ATUIN_HOME` is required for each environment's state. `ATUIN_CONFIG_DIR`, if set, must also select that environment's configuration. Existing XDG layouts are not automatically adopted: review their configuration/data/identity paths before deliberately migrating or selecting them. Native `atuin config set` preserves unrelated TOML keys and comments. Setup reapplies the selected sync URL, automatic record sync, daemon autostart, PTY proxy, output capture, and full thread capture on each run. It does not change personal filters or retention limits. Config writes are sequential, not transactional: if a write fails, correct the reported problem and rerun. Run setup serially with no other config writer. Back up existing configuration before first use.

Under the selected agent directory, `atuin/bin/atuin` is a profile-bound wrapper; `atuin/init.bash` and `atuin/init.zsh` prepend its directory to `PATH` only in interactive shells. MCP calls the same absolute wrapper. The wrapper binds the selected Atuin state selectors and canonical Pi directory so a GUI-launched MCP process, the PTY replacement shell, and the daemon use the same state as shell hooks. Interactive fragments only select that wrapper on `PATH`; neither the fragment nor wrapper rewrites unrelated XDG environment settings. Keep the underlying CLI path available; rerun setup after moving the checkout or provisioned binary. Managed wrappers are skipped when locating the underlying CLI on `PATH`.

For separate personal/work stores, set **both** a distinct `PI_CODING_AGENT_DIR` and an absolute `ATUIN_HOME` before each invocation, and use only that profile's shell fragment in its shells. If using `ATUIN_CONFIG_DIR`, select a distinct config directory too; otherwise it overrides both profiles' config. Do not source both fragments into one shell. The daemon inherits the selected Pi directory and `PI_CODING_AGENT_SESSION_DIR`, if set at setup time. These selectors are frozen for profile isolation; to change the watched root, rerun setup with the intended override and restart that profile's daemon. Runtime-only overrides do not retarget the generated launcher. Native Atuin watches Pi transcripts; no Pi extension is installed. Project-specific session-directory overrides outside the selected root are not guaranteed to be discovered. Native thread capture starts with new or continued sessions; continuing an old session can capture its entire transcript. No implicit bulk import occurs.

Keep authentication and enrollment in the environment adapter or a separate operator step. Do not put passwords, tokens, or encryption keys in command arguments, these docs, or MCP configuration. This command neither reads nor prints credential files.

To disable later, remove the portable `pi-env:atuin` profile block (or provisioner source line), remove `mcpServers.atuin`, and disable the native capture settings in the selected Atuin config. Stop that profile's daemon explicitly. Existing captured data remains; setup does not delete it.

## Verification

Use only a temporary home and agent directory for experiments. The functional suite can qualify an already downloaded/provisioned pinned CLI without network, login, import, or live home access:

```bash
PI_ENV_TEST_ATUIN=/absolute/path/to/atuin \
  node --test setup/__tests__/atuin.workflow.mjs
```

Without `PI_ENV_TEST_ATUIN`, native tests skip; version/capability failure tests still run as part of the setup suite. Native tests cover rerun preservation, managed profile ownership, portable profile reconciliation, isolated personal/work stores, effective capture settings, PTY initialization, and the stdio MCP tools handshake. They do not prove interactive terminal capture, live Pi transcript watching, remote authentication/sync, or macOS execution. Those require separate isolated end-to-end qualification before rollout.

Upstream contracts: [output capture](https://docs.atuin.sh/guide/output-capture/), [threads](https://docs.atuin.sh/ai/threads/), [MCP](https://docs.atuin.sh/ai/mcp/), and [daemon autostart](https://docs.atuin.sh/reference/daemon/). The pinned release's bundled documentation/source informed this integration; newer documentation may describe later behavior.
