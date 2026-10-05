# Nix support

Nix owns workbench provisioning. [Pi's upstream flake](https://github.com/badlogic/pi-mono) owns packaging the executable. Pi-env overrides its Node dependency with the runtime selected from the repository compatibility requirement.

## Authorities

| Concern | Source |
| --- | --- |
| Pi source revision | `flake.nix` input and `flake.lock` |
| Node compatibility floor | `package.json#engines.node` |
| Exact provisioned toolchain | `flake.lock` |
| Nub version | `package.json#packageManager` |
| JavaScript dependency graph | `package.json` and `nub.lock` |
| Pi resource selection | Pi's package manager and user/project settings |

Flake evaluation rejects a Node package below the compatibility floor, mismatched Pi development packages, or a Nub input that differs from the declared version. Updating Pi therefore changes the flake input and matching development packages together. There are no separate Node version files.

The flake supports Linux and macOS on x86_64 and aarch64. Intel macOS uses the upstream Pi flake's supported nixpkgs branch.

## Provisioning modes

- **Local Nix:** `nix run .#setup` supplies the workbench and retains it in a private profile at `~/.local/state/pi-env/toolchain`. Profile generations keep installed adapter paths valid across garbage collection and failed upgrades. Setup wraps the upstream package only for pi-env session-manager integration. Local Nix setup adds the private toolchain and adapter directories to shell profiles unless path configuration is externally managed or `--no-path` is set.
- **Externally managed:** `./setup.sh --nix-managed` consumes supplied tools. It does not write the Nix store or invoke Nix.
- **Portable:** `./setup.sh --portable` uses Nub's Node selection and the repository-installed Pi package. It uses the same Pi release as the Nix path.

An explicitly requested Nix operation fails visibly. It does not silently select another provisioner. Use portable mode explicitly when Nix is unavailable.

`PI_ENV_NODE_BIN` identifies a provisioned runtime. `PI_PACKAGE_DIR` identifies the supplied Pi package. Setup validates these inputs rather than searching unrelated runtime installations.

## Central builds and local personalization

Local Nix can obtain centrally built closures from a signed binary cache. Remote builders can handle cache misses. Builder access, cache trust, and activation belong to the host or infrastructure configuration, not pi-env setup.

An accessible local store is still required to run packages locally. A remote-only store does not make remote executable paths available on the client.

Keep settings, credentials, sessions, and local package registration mutable. Personal settings do not require rebuilding Pi. Container deployments can supply immutable toolchains while retaining a separate writable user store for optional packages.

## Home Manager

The module supplies tools, the upstream Pi package location, runtime selection, and optional shell/terminal integration:

```nix
{
  imports = [ inputs.pi-env.homeManagerModules.default ];
  pi-env = {
    enable = true;
    installTools = true;
    shell.enable = true;
    tmux.enable = true;
    ghostty.enable = false;
  };
}
```

Home Manager owns the declarative host profile and terminal integration. Pi owns interactive preferences. Setup owns resource registration and repository hydration. It does not force preferences on every run.

## Home Manager sync

`pi-env.homeManager.sync.enable` compares the standalone Home Manager input with the primary checkout's published main revision. Setup reports drift without activation. Explicit `./setup.sh --sync-home-manager` updates that input, verifies its revision, and switches Home Manager.

The module's `homeManager.sync.flake` and `homeManager.sync.input` options locate the consumer. Worktrees and feature branches skip synchronization. NixOS rebuilds and image deployments retain their own activation process.

## Kubernetes follow-up

The [Kubernetes architecture follow-up](kubernetes-agent-follow-up.md) proposes one immutable workbench artifact and one launch adapter, with personal state kept separate. It defines validation before adoption. Deployment remains an infrastructure contribution.

## Validation

Use flake checks for provisioning and dependency-free setup contracts. Use the repository verification portfolio for JavaScript, generated artifacts, and setup workflows. Do not activate profiles or reset live settings merely to validate a contribution.
