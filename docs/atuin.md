# Atuin

Use the [pinned package](../nix/atuin.nix) and [capture settings](../nix/atuin-settings.nix)
with native Home Manager options. Hosts own the sync endpoint, writable state,
credentials and activation. Without Nix, use [upstream installation](https://docs.atuin.sh/guide/installation/).

Before activation, review [capture exclusions](https://docs.atuin.sh/guide/excluding-commands/):
redaction is best-effort, local searchable state is not encrypted, and MCP results
can reach the model provider. Capture may include other supported agents under
the same user. History and thread text sync encrypted; terminal output stays local. Tool payloads are bounded around 64 KiB and may be clipped or
omitted, including media: capture is context, not lossless archival. Continuing
an existing session can capture its prior conversation.

## Pi command hook

Setup installs the reviewed upstream hook when `atuin` is on `PATH` and
`extensions/atuin.ts` is absent from the agent directory. Existing files and
symlinks remain untouched. For declarative ownership, use the packaged hook file
in the Home Manager example below. Reload Pi after installation or updates;
disable the hook through `pi config`.

The hook records Bash attempts, not proof of execution: a later permission denial
can appear as a failed history entry. Collector failures fail open but can delay
a call by ten seconds per collector invocation.

## Home Manager

For Home Manager 26.05, pass `inputs.pi-env` to the consuming module and replace
the example endpoint. Keep work and homelab services, credentials and state separate.
Never put secrets or mutable data in the Nix store.

```nix
{ config, inputs, lib, pkgs, ... }:
let
  atuin = inputs.pi-env.packages.${pkgs.stdenv.hostPlatform.system}.atuin;
  environment = {
    ATUIN_CONFIG_DIR = "${config.xdg.configHome}/atuin";
    ATUIN_HOME = "${config.xdg.dataHome}/atuin";
    PI_CODING_AGENT_DIR = "${config.home.homeDirectory}/.pi/agent";
  };
in
{
  home.file.".pi/agent/extensions/atuin-mcp.js".text = ''
    export default function (pi) {
      pi.registerMcpServer("atuin", ${builtins.toJSON {
        args = [ "mcp" ];
        command = lib.getExe atuin;
        env = environment;
      }});
    }
  '';
  home.file.".pi/agent/extensions/atuin.ts".source = "${atuin}/share/atuin/pi/atuin.ts";
  home.sessionVariables = environment;
  programs.atuin = {
    enable = true;
    enableBashIntegration = true;
    enableFishIntegration = false;
    enableNushellIntegration = false;
    enableZshIntegration = false;
    flags = [ "--disable-ai" ];
    package = atuin;
    settings = lib.recursiveUpdate inputs.pi-env.lib.atuin.captureSettings {
      output.max_disk_usage = "1GB";
      sync_address = "https://history.example.net";
    };
  };
  programs.bash.enable = true;
  xdg.enable = true;
}
```

Keep custom Pi/session directories aligned across the extension destination,
shell, daemon and MCP environment. If using Home Manager's daemon service instead
of autostart, disable `settings.daemon.autostart` and explicitly pass the same
environment to that service. Change managed TOML through Nix, not `atuin config set`.

## MCP ownership

Registration does not replace user `mcp.json`; `pi mcp add/remove` still manages
other servers. A same-name file entry overrides the declaration; removing it
reveals the declaration again. Inspect registered servers with `/mcp` inside Pi:
shell-level `pi mcp list` does not load extensions. In-session preference edits
are temporary unless persisted in the declaration or a user override.
