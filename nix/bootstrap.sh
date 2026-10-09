#!/usr/bin/env bash
# shellcheck source=/dev/null
source "$PI_ENV_AGENT_DIR_SCRIPT"
pi_env_resolve_agent_dir

target="${1:-$HOME/pi-env}"
repo_url="${PI_ENV_REPO_URL:-https://github.com/jhnguyy/pi-env.git}"

if [ -e "$target/.git" ]; then
  echo "pi-env checkout exists: $target"
elif [ -e "$target" ]; then
  echo "Bootstrap target exists but is not a Git checkout: $target" >&2
  exit 2
else
  mkdir -p "$(dirname "$target")"
  git clone "$repo_url" "$target"
fi

cd "$target"
exec "$PI_ENV_SETUP_COMMAND"
