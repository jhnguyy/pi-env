# Atuin

Atuin is opt-in and host-owned. Setup does not install or detect it.

Before enabling it, review [capture exclusions](https://docs.atuin.sh/guide/excluding-commands/):
redaction is best-effort, local searchable state is not encrypted, and MCP results
can reach the model provider. Capture may include other supported agents under
the same user. History and thread text sync encrypted; terminal output stays local. Tool payloads are bounded around 64 KiB and may be clipped or
omitted, including media: capture is context, not lossless archival. Continuing
an existing session can capture its prior conversation.

## Home Manager

`pi-env.atuin.enable` installs the [pinned client](../nix/atuin.nix) through
`programs.atuin` with the [capture defaults](../nix/atuin-settings.nix) and
`--disable-ai`. It also installs the native Pi command hook, an `atuin` MCP
server, and [agent guidance](../nix/atuin-guidance.md). The module sets these
values as defaults, so host `programs.atuin` options override them:

```nix
{
  pi-env.atuin.enable = true;
  programs.atuin.settings = {
    auto_sync = false;
    output.max_disk_usage = "1GB";
  };
}
```

Hosts own the sync endpoint, writable state, credentials and shell integration
choices. Keep work and homelab services, credentials and state separate. Never
put secrets or mutable data in the Nix store. Change managed TOML through Nix,
not `atuin config set`.

Disabling the option removes the integration but not data already captured under
`ATUIN_HOME`.

The module assumes Pi's default agent directory. If using Home Manager's daemon
service instead of autostart, disable `settings.daemon.autostart` and pass the
same `ATUIN_*` environment to that service.

## Without Home Manager

Use [upstream installation](https://docs.atuin.sh/guide/installation/),
`atuin hook install pi` for the command hook, and
[Pi's MCP documentation](https://pi.dev/docs/mcp) to register `atuin mcp`.
