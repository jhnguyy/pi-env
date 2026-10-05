#!/usr/bin/env bash
# shellcheck source=/dev/null
source "$PI_ENV_AGENT_DIR_SCRIPT"
pi_env_resolve_agent_dir

if [ ! -x ./setup.sh ] || [ ! -f ./package.json ]; then
  echo "Run the Nix setup app from a pi-env checkout." >&2
  exit 2
fi

mkdir -p "$HOME/.local/state/pi-env"
# Profile generations retain closures referenced by installed session adapters.
nix-env --profile "$HOME/.local/state/pi-env/toolchain" --install "$PI_ENV_TOOLCHAIN"
export PI_ENV_REPO="$PWD"
exec ./setup.sh "$@"
