# Atuin

Atuin is opt-in and host-owned. Setup does not install or detect it.

Before enabling it, review [capture exclusions](https://docs.atuin.sh/guide/excluding-commands/):
redaction is best-effort, local searchable state is not encrypted, and MCP results
can reach the model provider. Capture may include other supported agents under
the same user. History and thread text sync encrypted; terminal output stays local. Tool payloads are bounded around 64 KiB and may be clipped or
omitted, including media: capture is context, not lossless archival. Continuing
an existing session can capture its prior conversation.

## Home Manager

Each toggle is off by default and widens what Atuin records or shares:

| Option                        | Adds                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-env.atuin.enable`         | The [pinned client](../nix/atuin.nix) with `--disable-ai`, local shell history, and the Pi command hook, which records bash commands Pi runs |
| `pi-env.atuin.sync.enable`    | Automatic encrypted sync to the configured server                                                                                            |
| `pi-env.atuin.capture.enable` | Terminal output capture through the PTY proxy, and agent thread capture                                                                      |
| `pi-env.atuin.mcp.enable`     | An `atuin` MCP server for Pi with its [guidance](../nix/atuin-guidance.md)                                                                   |

The toggles set `programs.atuin.settings` as defaults, so host values override
them. They are configuration, not enforcement: block the sync endpoint on the
network when sync must not happen.

```nix
{
  pi-env.atuin = {
    enable = true;
    mcp.enable = true;
  };
  programs.atuin.settings.sync_address = "https://history.example.net";
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
