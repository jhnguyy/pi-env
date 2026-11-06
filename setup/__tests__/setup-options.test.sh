#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

# A stub nix reports its argv on stdout, which exec passes through setup.sh.
test_nix_entrypoints_delegate_without_portable_fallback() {
  local tmp status=0
  tmp="$(with_temp_dir)"
  make_executable "$tmp/nix" '#!/bin/sh
printf "%s\n" "$*"'
  run_setup() {
    env -u PI_ENV_SETUP_MODE -u PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_AUTO_NIX=1 \
      HOME="$tmp/home" PI_AGENT_DIR="$tmp/agent" PI_CODING_AGENT_DIR="$tmp/agent" \
      PATH="$tmp:$PATH" "$ROOT/setup.sh" "$@"
  }

  assert_eq "$(run_setup --no-terminal)" "run .#setup -- --no-terminal" "plain ./setup.sh should auto-run nix setup"
  assert_eq "$(run_setup --use-nix --no-terminal)" "run .#setup -- --no-terminal" "--use-nix should re-exec nix setup"

  make_executable "$tmp/nix" '#!/bin/sh
exit 37'
  run_setup --reset >/dev/null 2>&1 || status=$?
  assert_eq "$status" 37 'Nix failure remains visible'
  [ ! -e "$tmp/agent/settings.json" ] || fail 'Nix failure must not fall back to portable setup'
}

test_nix_entrypoints_delegate_without_portable_fallback

echo "setup option tests passed"
