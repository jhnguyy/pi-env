# Declarative Atuin capture

Atuin provides shell history, terminal output capture, native Pi thread capture (including tool input/output), and a native stdio MCP server. Normal pi-env setup does not enable capture or onboard an account. Nix exports a pinned compatible [`packages.<system>.atuin`](../nix/atuin.nix) and pure [`lib.atuin.captureSettings`](../nix/atuin-settings.nix); hosts own configuration, state, authentication, and activation.

**Privacy:** capture can retain conversations, code, commands, and terminal output, including threads from other supported coding agents. Filters and redaction are best-effort, not a security boundary. Review [Atuin's exclusions](https://docs.atuin.sh/guide/excluding-commands/) before enabling capture. After authentication, history and threads sync to the selected server using encrypted record sync. **Output stays local in the pinned release.** MCP exposes the selected store across projects.

Without Nix, use [Atuin's upstream installation](https://docs.atuin.sh/guide/installation/) and configuration together with Pi's native MCP configuration. pi-env does not maintain a parallel installer.

## Home Manager

Use native `programs.atuin` for the package, settings, and shell hooks. The example targets Home Manager release 26.05; replace the host's sync URL and choose its storage/retention policy before activation. The generic settings contain no endpoint or storage budget.

In the consuming Home Manager configuration, with the locked `pi-env` input passed as `inputs.pi-env`:

```nix
{ config, inputs, lib, pkgs, ... }:
let
  atuin = inputs.pi-env.packages.${pkgs.stdenv.hostPlatform.system}.atuin;
  captureSettings = inputs.pi-env.lib.atuin.captureSettings;
  # Host-owned absolute selectors; keep mutable state outside the Nix store.
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
  home.sessionVariables = environment;
  programs.atuin = {
    enable = true;
    enableBashIntegration = true;
    enableFishIntegration = false;
    enableNushellIntegration = false;
    enableZshIntegration = false;
    flags = [ "--disable-ai" ];
    package = atuin;
    settings = lib.recursiveUpdate captureSettings {
      output.max_disk_usage = "1GB"; # Example host policy, not a library default.
      sync_address = "https://history.example.net"; # Replace with this host's server.
    };
  };
  programs.bash.enable = true;
  xdg.enable = true;
}
```

Keep `ATUIN_CONFIG_DIR` aligned with the native module's generated configuration. For Zsh, enable `programs.zsh` and its Atuin integration instead of Bash. Do not add another `atuin init` hook or profile wrapper. The native hook receives `--disable-ai`, disabling AI command-generation bindings without disabling thread capture or MCP.

Default daemon autostart is sufficient: the interactive hooks start the daemon with the shell's environment, and native initialization starts the PTY proxy. Ensure the host session exports the selectors before opening a new interactive shell. GUI-launched Pi must also receive its agent-directory selector. Native thread capture watches Pi transcripts; no Pi capture extension is needed. Custom session roots must be supplied consistently through `PI_CODING_AGENT_SESSION_DIR` to the shell, daemon, and MCP environment, and require separate discovery qualification.

### Optional managed daemon service

Only when the host needs service-manager lifecycle ownership, also set `programs.atuin.daemon.enable = true`. This is the native Home Manager systemd/launchd service, distinct from `settings.daemon.enabled`. Do not run a competing autostarted daemon: set `programs.atuin.settings.daemon.autostart = lib.mkForce false`.

Services do not automatically inherit `home.sessionVariables`. In the same module scope as the example, explicitly propagate `environment` using the platform-appropriate addition:

```nix
# Linux: native Home Manager service and socket activation.
systemd.user.services.atuin-daemon.Service.Environment =
  lib.mapAttrsToList (name: value: "${name}=${value}") environment;

# macOS alternative (not alongside the Linux declaration).
launchd.agents.atuin-daemon.config.EnvironmentVariables = environment;
```

Include any host-owned session-root override in that environment too. Home Manager configures the native socket behavior; do not replace it with a custom launcher. Activate and restart services only through the owning host's approved deployment procedure.

## Ownership and environment boundaries

Home Manager renders non-secret TOML into an immutable Nix-store file. Do not use `atuin config set` on that TOML. Leave `forceOverwriteSettings` disabled; review and migrate an existing unmanaged configuration rather than blindly replacing it. Credentials, encryption keys, databases, captured output, sockets, and logs belong in writable host-owned state, never in Nix expressions, the store, MCP JSON, or command arguments. Account enrollment/login and secret delivery are separate host/operator responsibilities; this library performs neither.

Keep work and homelab in separate host configurations, with separate services/databases, accounts, keys, and local state. Identical local paths on different machines are fine; a general-purpose profile manager is unnecessary. Do not share a store or daemon across that boundary. Each host chooses its sync endpoint, output budget, filters, retention, and persistence. Existing XDG/default state is not automatically migrated. A continued old Pi session can capture its full transcript; enabling capture is not an implicit bulk import.

A container consumer can merge `lib.atuin.captureSettings` with its host policy, render immutable TOML, and own native shell initialization (`atuin init bash --disable-ai` or Zsh). It must export the same selectors to every process and persist mutable state separately. Container startup, secret mounts, and deployment verification belong to the consumer.

To disable capture, change the owning declarative configuration, remove the Atuin MCP entry and shell integration, and explicitly stop the selected daemon through its lifecycle owner. Existing captured state remains until the host's retention/deletion policy removes it.

## MCP registration

The example uses Pi's native `registerMcpServer` API instead of replacing the shared user `mcp.json`. Other servers remain user-managed through that file and `pi mcp add/remove`; a file-defined server named `atuin` overrides the registration. Removing that override reveals the declaration again rather than deleting it. Include any custom Pi directory in the managed extension destination as well as its environment.

Inspect registration inside Pi with `/mcp`. Shell-level `pi mcp list` does not load extensions. Changes to an extension-defined server's exposure/enabled state last only for that session; persist them in its declaration or a user-defined override.

## Verification boundary

Evaluate the settings and pinned package for the target platform without accessing host state. For example, from this checkout:

```bash
nix eval --json .#lib.atuin.captureSettings
nix eval --raw .#packages.x86_64-linux.atuin.version
```

These checks do not activate a profile, start capture, or prove host environment propagation. Existing isolated native experiments established the pinned release's capture and MCP features; pi-env does not maintain an upstream-behavior test suite. Host activation, interactive capture, transcript discovery, remote authentication/sync, and native macOS execution remain consuming-host qualification responsibilities.

Upstream contracts: [output capture](https://docs.atuin.sh/guide/output-capture/), [threads](https://docs.atuin.sh/ai/threads/), [MCP](https://docs.atuin.sh/ai/mcp/), and [daemon](https://docs.atuin.sh/reference/daemon/). Newer upstream documentation may describe behavior beyond the pinned release.
