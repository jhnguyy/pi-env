#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

test_node_bin() {
  if [ -x /bin/node ]; then
    printf '%s\n' /bin/node
  else
    command -v node
  fi
}

run_pi_cli_setup() {
  local node_bin
  node_bin=$(test_node_bin)
  REPO="$REPO" \
  SETUP_DIR="$ROOT/setup" \
  PI_BIN_DIR="$PI_BIN_DIR" \
  PI_ENV_NODE_BIN="${PI_ENV_NODE_BIN:-}" \
  PI_ENV_CONFIG_MANAGED_BY_NIX="${PI_ENV_CONFIG_MANAGED_BY_NIX:-}" \
  PI_ENV_CLI_MANAGED_BY_NIX="${PI_ENV_CLI_MANAGED_BY_NIX:-}" \
  PI_ENV_SKIP_PATH_PROFILE="${PI_ENV_SKIP_PATH_PROFILE:-}" \
  "$node_bin" "$ROOT/setup/runtime.mjs" "${PI_ENV_NODE_BIN:-$node_bin}" pi-cli >/dev/null
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
  tmp="$(with_temp_dir)"
  old_path="$PATH"

  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  PI_ENV_NODE_BIN=$(test_node_bin)
  create_stub_repo "$tmp"

  run_pi_cli_setup

  [ -x "$PI_BIN_DIR/pi" ] || fail "pi wrapper should be executable"
  grep -qF "DEFAULT_PI_PACKAGE_DIR='$REPO/node_modules/@earendil-works/pi-coding-agent'" "$PI_BIN_DIR/pi" || fail "wrapper should point at repo node_modules pi package"
  if grep -qF 'PI_CLI_ROOT' "$PI_BIN_DIR/pi"; then
    fail "wrapper should no longer depend on separate PI_CLI_ROOT npm install"
  fi
  PI_PACKAGE_DIR="$tmp/missing/@earendil-works/pi-coding-agent" "$PI_BIN_DIR/pi" | grep -qF 'stub pi' || fail "wrapper should ignore stale invalid PI_PACKAGE_DIR and use repo package"

  PATH="$old_path"
  unset PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_pins_configured_node() {
  local tmp fake_node
  tmp="$(with_temp_dir)"
  fake_node="$tmp/node"

  create_stub_repo "$tmp"
  cat > "$fake_node" <<'SH'
#!/usr/bin/env sh
if [ "$1" = "-e" ]; then
  echo "1.2.3"
  exit 0
fi
echo "fake node: $*"
SH
  chmod +x "$fake_node"

  PI_ENV_NODE_BIN="$fake_node"
  run_pi_cli_setup

  grep -qF "NODE_BIN='$fake_node'" "$PI_BIN_DIR/pi" || fail "wrapper should pin configured node path"
  local wrapper_output
  wrapper_output=$(PI_PACKAGE_DIR= "$PI_BIN_DIR/pi")
  printf '%s' "$wrapper_output" | grep -qF "fake node: $REPO/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" || fail "wrapper should execute configured node (got: $wrapper_output)"

  unset PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_skips_write_when_managed_by_nix() {
  local tmp
  tmp="$(with_temp_dir)"

  PI_ENV_CLI_MANAGED_BY_NIX=1
  PI_ENV_NODE_BIN=$(test_node_bin)
  create_stub_repo "$tmp"

  run_pi_cli_setup

  [ ! -e "$PI_BIN_DIR/pi" ] || fail "setup should not write pi wrapper when Nix manages it"

  unset PI_ENV_CLI_MANAGED_BY_NIX PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_adds_path_profile_when_portable() {
  local tmp old_home old_path
  tmp="$(with_temp_dir)"
  old_home="$HOME"
  old_path="$PATH"

  HOME="$tmp/home"
  PATH="/bin"
  mkdir -p "$HOME"
  PI_ENV_NODE_BIN=$(test_node_bin)
  create_stub_repo "$tmp"

  unset PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_CLI_MANAGED_BY_NIX PI_ENV_SKIP_PATH_PROFILE || true
  run_pi_cli_setup
  run_pi_cli_setup

  assert_file_contains "$HOME/.profile" "export PATH=\"$PI_BIN_DIR:\$PATH\""
  assert_file_count "$HOME/.profile" '# pi-env: add user-local bin to PATH' 1
  assert_file_count "$HOME/.profile" "export PATH=\"$PI_BIN_DIR:\$PATH\"" 1

  HOME="$old_home"
  PATH="$old_path"
  unset PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_uses_repo_locked_package
test_pi_cli_wrapper_pins_configured_node
test_pi_cli_wrapper_skips_write_when_managed_by_nix
test_pi_cli_wrapper_adds_path_profile_when_portable

echo "pi CLI wrapper tests passed"
