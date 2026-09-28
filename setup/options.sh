#!/usr/bin/env bash
# Command-line option parsing for setup.sh.

setup_parse_args() {
  case "${PI_ENV_SETUP_MODE:-}:${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}" in
    :1) PI_ENV_SETUP_MODE="nix-managed" ;;
    :*) PI_ENV_SETUP_MODE="portable" ;;
  esac
  PI_ENV_SKIP_TERMINAL="${PI_ENV_SKIP_TERMINAL:-0}"
  PI_ENV_SKIP_REPO_HOOKS="${PI_ENV_SKIP_REPO_HOOKS:-0}"
  PI_ENV_BOOTSTRAP_NUB=0
  local portable_requested=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --nix-managed)
        PI_ENV_SETUP_MODE="nix-managed"
        PI_ENV_CONFIG_MANAGED_BY_NIX=1
        ;;
      --portable)
        PI_ENV_SETUP_MODE="portable"
        PI_ENV_CONFIG_MANAGED_BY_NIX=0
        portable_requested=1
        ;;
      --bootstrap-nub)
        PI_ENV_BOOTSTRAP_NUB=1
        ;;
      --no-terminal)
        PI_ENV_SKIP_TERMINAL=1
        ;;
      --no-path)
        PI_ENV_SKIP_PATH_PROFILE=1
        ;;
      --no-repo-hooks)
        PI_ENV_SKIP_REPO_HOOKS=1
        ;;
      -h|--help)
        cat <<'EOF'
Usage: ./setup.sh [options]

When Nix is available, plain ./setup.sh automatically tries the recommended
Nix setup app before falling back to portable setup.

Options:
  --nix-managed    Force Nix/Home Manager ownership of shell and terminal config.
                   Skips PATH profile edits, tmux writes, and Ghostty writes.
  --portable       Force portable setup. Setup may update shell profiles and link
                   terminal config when appropriate.
  --bootstrap-nub  With --portable, use a verified temporary Nub if PATH Nub is
                   missing or does not match package.json#packageManager.
  --no-terminal    Skip tmux and Ghostty setup.
  --no-path        Skip shell profile PATH edits.
  --no-repo-hooks  Skip repo hook installation.
  -h, --help       Show this help.

Entrypoint-only options/env:
  --use-nix        Re-exec nix run .#setup from the repo root.
  PI_ENV_AUTO_NIX=0 disables automatic nix run from plain ./setup.sh.
EOF
        exit 0
        ;;
      *)
        echo "Unknown setup option: $1" >&2
        echo "Run ./setup.sh --help for usage." >&2
        exit 2
        ;;
    esac
    shift
  done

  if [ "$PI_ENV_BOOTSTRAP_NUB" = 1 ] && { [ "$portable_requested" != 1 ] || [ "$PI_ENV_SETUP_MODE" != portable ]; }; then
    echo "--bootstrap-nub requires --portable; it never changes a Nix-managed toolchain." >&2
    exit 2
  fi
  export PI_ENV_BOOTSTRAP_NUB
  export PI_ENV_SETUP_MODE PI_ENV_SKIP_TERMINAL PI_ENV_SKIP_REPO_HOOKS
  export PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_SKIP_PATH_PROFILE
}
