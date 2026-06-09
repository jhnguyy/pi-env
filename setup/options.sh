#!/usr/bin/env bash
# Command-line option parsing for setup.sh.

setup_parse_args() {
  PI_ENV_SETUP_MODE="${PI_ENV_SETUP_MODE:-portable}"
  PI_ENV_SKIP_TERMINAL="${PI_ENV_SKIP_TERMINAL:-0}"
  PI_ENV_SKIP_REPO_HOOKS="${PI_ENV_SKIP_REPO_HOOKS:-0}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --nix-managed)
        PI_ENV_SETUP_MODE="nix-managed"
        PI_ENV_CONFIG_MANAGED_BY_NIX=1
        ;;
      --portable)
        PI_ENV_SETUP_MODE="portable"
        PI_ENV_CONFIG_MANAGED_BY_NIX=0
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

Options:
  --nix-managed    Assume Nix/Home Manager owns shell and terminal config.
                   Skips PATH profile edits, tmux writes, and Ghostty writes.
  --portable       Portable default. Setup may update shell profiles and link
                   terminal config when appropriate.
  --no-terminal    Skip tmux and Ghostty setup.
  --no-path        Skip shell profile PATH edits.
  --no-repo-hooks  Skip repo hook installation.
  -h, --help       Show this help.
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

  export PI_ENV_SETUP_MODE PI_ENV_SKIP_TERMINAL PI_ENV_SKIP_REPO_HOOKS
  export PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_SKIP_PATH_PROFILE
}
