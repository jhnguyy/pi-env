#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
PROBE_NODE=$(node_bin)
record_adapter_probe() {
  DIR="$1" PROBE="$2" STATUS="$3" "$PROBE_NODE" --input-type=module <<'JS'
import fs from 'node:fs';
fs.writeFileSync(`${process.env.DIR}/result.json`, JSON.stringify({
  inputs: process.env.PROBE,
  expected: 'installed adapter dispatches to the supplied package; local Nix PATH entries remain usable and idempotent',
  actual: {exitStatus: Number(process.env.STATUS)}, verdict: process.env.STATUS === '0' ? 'pass' : 'fail',
  reproduce: 'bash setup/__tests__/pi-cli-wrapper.test.sh', inspect: 'bin/pi, home/.profile, and *.log',
}, null, 2) + '\n');
JS
}

run_pi_cli_setup() {
  local selected_node_bin
  selected_node_bin=$(PI_ENV_NODE_BIN= node_bin)
  REPO="$REPO" \
  SETUP_DIR="$ROOT/setup" \
  PI_BIN_DIR="$PI_BIN_DIR" \
  PI_ENV_NODE_BIN="${PI_ENV_NODE_BIN:-}" \
  PI_ENV_CONFIG_MANAGED_BY_NIX="${PI_ENV_CONFIG_MANAGED_BY_NIX:-}" \
  PI_ENV_CLI_MANAGED_BY_NIX="${PI_ENV_CLI_MANAGED_BY_NIX:-}" \
  PI_ENV_SKIP_PATH_PROFILE="${PI_ENV_SKIP_PATH_PROFILE:-}" \
  "$selected_node_bin" "$ROOT/setup/runtime.mjs" "${PI_ENV_NODE_BIN:-$selected_node_bin}" pi-cli >/dev/null
}

create_stub_repo() {
  local pi_entry
  pi_entry="${2:-dist/cli.js}"
  REPO="$1/repo"
  PI_BIN_DIR="$1/bin"
  mkdir -p "$REPO/node_modules/@earendil-works/pi-coding-agent/$(dirname "$pi_entry")" \
    "$REPO/.pi/extensions/session-manager/dist" "$PI_BIN_DIR"
  cat > "$REPO/package.json" <<'JSON'
{
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.2.3"
  }
}
JSON
  cat > "$REPO/node_modules/@earendil-works/pi-coding-agent/package.json" <<JSON
{
  "name": "@earendil-works/pi-coding-agent",
  "version": "1.2.3",
  "bin": {
    "pi": "$pi_entry"
  }
}
JSON
  cat > "$REPO/node_modules/@earendil-works/pi-coding-agent/$pi_entry" <<'JS'
console.log('stub pi', JSON.stringify(process.argv.slice(2)))
JS
  cat > "$REPO/.pi/extensions/session-manager/dist/start.js" <<'JS'
console.log('stub session manager start')
JS
  : > "$REPO/.pi/extensions/session-manager/dist/index.js"
}

test_pi_cli_wrapper_uses_repo_locked_package() {
  local tmp old_path
  tmp="$(with_temp_dir)"
  old_path="$PATH"

  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  PI_ENV_NODE_BIN=$(node_bin)
  create_stub_repo "$tmp"

  run_pi_cli_setup

  [ -x "$PI_BIN_DIR/pi" ] || fail "pi wrapper should be executable"
  PI_PACKAGE_DIR="$tmp/missing/@earendil-works/pi-coding-agent" "$PI_BIN_DIR/pi" | grep -qF 'stub pi' || fail "wrapper should ignore stale invalid PI_PACKAGE_DIR and use repo package"

  PATH="$old_path"
  unset PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_uses_declared_package_entry() {
  local tmp
  tmp="$(with_temp_dir)"

  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  PI_ENV_NODE_BIN=$(node_bin)
  create_stub_repo "$tmp" "dist/bundle/cli.js"

  run_pi_cli_setup

  [ -x "$PI_BIN_DIR/pi" ] || fail "pi wrapper should be executable"
  [ ! -e "$REPO/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" ] || fail "fixture should not contain the legacy entrypoint"
  PI_PACKAGE_DIR= "$PI_BIN_DIR/pi" | grep -qF 'stub pi' || fail "pi wrapper should execute the package-declared entrypoint"

  unset PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_pins_configured_node() {
  local tmp fake_node old_home
  tmp="$(with_temp_dir)"
  fake_node="$tmp/node"
  # Portable setup edits shell profiles because the stub bin dir is not in PATH.
  old_home="$HOME"
  HOME="$tmp/home"
  mkdir -p "$HOME"

  create_stub_repo "$tmp"
  cat > "$fake_node" <<'SH'
#!/usr/bin/env sh
if [ "$1" = "-e" ]; then
  echo "1.2.3"
  exit 0
fi
echo "fake node: $*"
echo "PI_ENV_NODE_BIN=$PI_ENV_NODE_BIN"
SH
  chmod +x "$fake_node"

  PI_ENV_NODE_BIN="$fake_node"
  run_pi_cli_setup

  local wrapper_output
  wrapper_output=$(PI_PACKAGE_DIR= "$PI_BIN_DIR/pi")
  printf '%s' "$wrapper_output" | grep -qF "fake node: $REPO/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" || fail "wrapper should execute configured node (got: $wrapper_output)"
  printf '%s' "$wrapper_output" | grep -qF "PI_ENV_NODE_BIN=$fake_node" || fail "wrapper should expose the configured node to sidecars"

  HOME="$old_home"
  unset PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_intercepts_only_exact_start() {
  local tmp output
  tmp="$(with_temp_dir)"

  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  PI_ENV_NODE_BIN=$(node_bin)
  create_stub_repo "$tmp"
  run_pi_cli_setup

  output=$(PI_PACKAGE_DIR= "$PI_BIN_DIR/pi" --start)
  [ "$output" = "stub session manager start" ] || fail "exact --start should use the session manager sidecar"

  output=$(PI_PACKAGE_DIR= "$PI_BIN_DIR/pi" --start --model "model with spaces")
  printf '%s' "$output" | grep -qF 'stub pi ["--start","--model","model with spaces"]' || fail "mixed --start argv should pass through unchanged"
  output=$(PI_PACKAGE_DIR= "$PI_BIN_DIR/pi" value --start)
  printf '%s' "$output" | grep -qF 'stub pi ["value","--start"]' || fail "positional --start should pass through unchanged"
  output=$(PI_PACKAGE_DIR= "$PI_BIN_DIR/pi" -- --start)
  printf '%s' "$output" | grep -qF 'stub pi ["--","--start"]' || fail "post-separator --start should pass through unchanged"

  unset PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_skips_write_when_managed_by_nix() {
  local tmp
  tmp="$(with_temp_dir)"

  PI_ENV_CLI_MANAGED_BY_NIX=1
  PI_ENV_NODE_BIN=$(node_bin)
  create_stub_repo "$tmp"

  run_pi_cli_setup

  [ ! -e "$PI_BIN_DIR/pi" ] || fail "setup should not write pi wrapper when Nix manages it"

  unset PI_ENV_CLI_MANAGED_BY_NIX PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_adds_path_profile_when_portable() (
  local tmp old_home old_path mode="${1:-portable}"
  tmp="$(with_temp_dir)"
  if [ "$mode" = local-nix ]; then
    printf 'Local Nix adapter evidence: %s\n' "$tmp"
    trap 'record_adapter_probe "$tmp" "local-nix PATH configuration" "$?"' EXIT
  fi
  old_home="$HOME"
  old_path="$PATH"

  PI_ENV_NODE_BIN=$(node_bin)
  PI_ENV_TEST_NODE_BIN=$PI_ENV_NODE_BIN
  HOME="$tmp/home"
  PATH="$old_path"
  mkdir -p "$HOME"
  create_stub_repo "$tmp"

  unset PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_CLI_MANAGED_BY_NIX PI_ENV_SKIP_PATH_PROFILE || true
  PI_ENV_SETUP_MODE="$mode" run_pi_cli_setup
  PI_ENV_SETUP_MODE="$mode" run_pi_cli_setup

  if [ "$mode" = local-nix ]; then
    assert_file_count "$HOME/.profile" "$HOME/.local/state/pi-env/toolchain/bin" 1
  fi
  assert_file_contains "$HOME/.profile" "export PATH=\"$PI_BIN_DIR:\$PATH\""
  assert_file_count "$HOME/.profile" '# pi-env: add user-local bin to PATH' 1
  assert_file_count "$HOME/.profile" "export PATH=\"$PI_BIN_DIR:\$PATH\"" 1

  HOME="$old_home"
  PATH="$old_path"
  unset PI_ENV_NODE_BIN PI_ENV_TEST_NODE_BIN
  if [ "$mode" != local-nix ]; then rm -rf "$tmp"; fi
)

# Probe package layout and dispatch without realizing Nix or starting an interactive session.
test_pi_cli_adapter_accepts_upstream_package() (
  local tmp upstream
  tmp="$(with_temp_dir)"
  printf 'Supplied package adapter evidence: %s\n' "$tmp"
  trap 'record_adapter_probe "$tmp" "externally supplied package and exact --start dispatch" "$?"' EXIT
  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  PI_ENV_NODE_BIN=$(node_bin)
  create_stub_repo "$tmp" "dist/upstream-cli.js"
  upstream="$tmp/upstream"
  mv "$REPO/node_modules/@earendil-works/pi-coding-agent" "$upstream"
  PI_PACKAGE_DIR="$upstream" run_pi_cli_setup
  PI_PACKAGE_DIR= "$PI_BIN_DIR/pi" >"$tmp/package.log" 2>&1
  assert_file_contains "$tmp/package.log" 'stub pi'
  PI_PACKAGE_DIR= "$PI_BIN_DIR/pi" --start >"$tmp/session.log" 2>&1
  assert_file_contains "$tmp/session.log" 'stub session manager start'
)

test_pi_cli_adapter_accepts_upstream_package
test_pi_cli_wrapper_uses_repo_locked_package
test_pi_cli_wrapper_uses_declared_package_entry
test_pi_cli_wrapper_pins_configured_node
test_pi_cli_wrapper_intercepts_only_exact_start
test_pi_cli_wrapper_skips_write_when_managed_by_nix
test_pi_cli_wrapper_adds_path_profile_when_portable
test_pi_cli_wrapper_adds_path_profile_when_portable local-nix

echo "pi CLI wrapper tests passed"
