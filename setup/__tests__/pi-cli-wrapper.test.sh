#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=setup/lib.sh
source "$ROOT/setup/lib.sh"
# shellcheck source=setup/install.sh
source "$ROOT/setup/install.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

create_stub_repo() {
  REPO="$1/repo"
  PI_BIN_DIR="$1/bin"
  mkdir -p "$REPO/node_modules/@earendil-works/pi-coding-agent/dist" "$PI_BIN_DIR"
  cat > "$REPO/package.json" <<'JSON'
{
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.2.3"
  }
}
JSON
  cat > "$REPO/node_modules/@earendil-works/pi-coding-agent/package.json" <<'JSON'
{
  "name": "@earendil-works/pi-coding-agent",
  "version": "1.2.3"
}
JSON
  cat > "$REPO/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" <<'JS'
console.log('stub pi')
JS
}

test_pi_cli_wrapper_uses_repo_locked_package() {
  local tmp old_path
  tmp="$(mktemp -d)"
  old_path="$PATH"

  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  create_stub_repo "$tmp"

  setup_install_pi_cli >/dev/null

  [ -x "$PI_BIN_DIR/pi" ] || fail "pi wrapper should be executable"
  grep -qF "DEFAULT_PI_PACKAGE_DIR='$REPO/node_modules/@earendil-works/pi-coding-agent'" "$PI_BIN_DIR/pi" || fail "wrapper should point at repo node_modules pi package"
  if grep -qF 'PI_CLI_ROOT' "$PI_BIN_DIR/pi"; then
    fail "wrapper should no longer depend on separate PI_CLI_ROOT npm install"
  fi
  PI_PACKAGE_DIR="$tmp/missing/@earendil-works/pi-coding-agent" "$PI_BIN_DIR/pi" | grep -qF 'stub pi' || fail "wrapper should ignore stale invalid PI_PACKAGE_DIR and use repo package"

  PATH="$old_path"
  unset PI_ENV_CONFIG_MANAGED_BY_NIX
  rm -rf "$tmp"
}

test_pi_cli_wrapper_skips_write_when_managed_by_nix() {
  local tmp
  tmp="$(mktemp -d)"

  PI_ENV_CLI_MANAGED_BY_NIX=1
  create_stub_repo "$tmp"

  setup_install_pi_cli >/dev/null

  [ ! -e "$PI_BIN_DIR/pi" ] || fail "setup should not write pi wrapper when Nix manages it"

  unset PI_ENV_CLI_MANAGED_BY_NIX
  rm -rf "$tmp"
}

test_pi_cli_wrapper_uses_repo_locked_package
test_pi_cli_wrapper_skips_write_when_managed_by_nix

echo "pi CLI wrapper tests passed"
