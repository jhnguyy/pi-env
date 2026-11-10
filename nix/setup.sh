#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source "$PI_ENV_AGENT_DIR_SCRIPT"
pi_env_resolve_agent_dir

if [ ! -x ./setup.sh ] || [ ! -f ./package.json ]; then
  echo "Run the Nix setup app from a pi-env checkout." >&2
  exit 2
fi

# Parse in a subshell: validation/help must not install a profile, and setup.sh
# must still select its mode from the original environment and arguments.
# shellcheck source=setup/options.sh
source ./setup/options.sh
(setup_parse_args "$@")
for arg in "$@"; do
  case "$arg" in
    -h|--help) exit 0 ;;
  esac
done

mkdir -p "$HOME/.local/state/pi-env"
# Profile generations retain closures referenced by installed session adapters.
nix-env --profile "$HOME/.local/state/pi-env/toolchain" --install "$PI_ENV_TOOLCHAIN"
export PI_ENV_REPO="$PWD"
exec ./setup.sh "$@"
