#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
cd "$ROOT"
NODE_BIN=$(node_bin)
tmp=$(with_temp_dir)

# Each setup error renders exactly once on stderr and keeps its exit status.
expect_error() {
  local expected_status="$1" pattern="$2" stderr status=0
  shift 2
  stderr=$("$@" 2>&1 >/dev/null) || status=$?
  assert_eq "$status" "$expected_status" "exit status for: $pattern"
  assert_eq "$(grep -cE "$pattern" <<<"$stderr")" 1 "single rendering of: $pattern (got: $stderr)"
}

expect_error 1 '^REPO is required$' env REPO= "$NODE_BIN" setup/configure.mjs pi

export REPO="$ROOT" HOME="$tmp/home"
mkdir -p "$HOME"
export PI_AGENT_DIR="$tmp/pi-agent" PI_CODING_AGENT_DIR="$tmp/pi-agent"
export AGENTS_DIR="$HOME/.agents" XDG_CONFIG_HOME="$tmp/xdg" GHOSTTY_CONFIG_DIR="$tmp/xdg/ghostty"

expect_error 2 '^unknown configure command: not-a-command$' "$NODE_BIN" setup/configure.mjs not-a-command
expect_error 1 'no-such-node setup/apply-managed-settings.mjs .* failed to start:' \
  "$NODE_BIN" setup/configure.mjs pi "$tmp/no-such-node"
make_executable "$tmp/node-fails" '#!/bin/sh
echo injected failure >&2
exit 7'
expect_error 7 'node-fails setup/apply-managed-settings.mjs .* exited with 7: injected failure' \
  "$NODE_BIN" setup/configure.mjs pi "$tmp/node-fails"

echo "effect runtime tests passed"
