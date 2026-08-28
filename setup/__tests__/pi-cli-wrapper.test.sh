#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

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
  REPO="$1/repo"
  PI_BIN_DIR="$1/bin"
  mkdir -p "$REPO/node_modules/@earendil-works/pi-coding-agent/dist" "$REPO/.pi/extensions/session-resume/dist" "$PI_BIN_DIR"
  : > "$REPO/.pi/extensions/session-resume/dist/index.js"
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
  PI_ENV_NODE_BIN=$(node_bin)
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
  grep -qF 'export PI_ENV_NODE_BIN="$NODE_BIN"' "$PI_BIN_DIR/pi" || fail "wrapper should expose the selected Node runtime to sidecars"
  grep -qF "PI_NODE_ARGV0=pi exec \"\$NODE_BIN\" \"\$PI_ENTRY\" \"\$@\"" "$PI_BIN_DIR/pi" || fail "wrapper should request pi argv0 for title detection"
  local wrapper_output
  wrapper_output=$(PI_PACKAGE_DIR= "$PI_BIN_DIR/pi")
  printf '%s' "$wrapper_output" | grep -qF "fake node: $REPO/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" || fail "wrapper should execute configured node (got: $wrapper_output)"

  unset PI_ENV_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_intercepts_exact_resume_flags() {
  local tmp fake_node work_dir selected_path calls
  tmp="$(with_temp_dir)"
  fake_node="$tmp/node"
  work_dir="$tmp/work dir"
  selected_path="$tmp/session dir/selected session.jsonl"
  calls="$tmp/calls"

  create_stub_repo "$tmp"
  mkdir -p "$work_dir" "$(dirname "$selected_path")"
  : > "$selected_path"
  cat > "$fake_node" <<'SH'
#!/usr/bin/env sh
{
  echo "call"
  echo "pwd=$PWD"
  echo "resume=${PI_ENV_SESSION_RESUME:-}"
  index=1
  for arg in "$@"; do
    echo "arg${index}=$arg"
    index=$((index + 1))
  done
} >> "$PI_ENV_TEST_CALLS"
if [ "${PI_ENV_SESSION_RESUME:-}" = "1" ] && [ -n "${PI_ENV_TEST_SELECTED_SESSION:-}" ]; then
  printf '%s' "$PI_ENV_TEST_SELECTED_SESSION" > "$PI_ENV_SESSION_RESUME_FILE"
fi
exit "${PI_ENV_TEST_EXIT:-0}"
SH
  chmod +x "$fake_node"

  PI_ENV_NODE_BIN="$fake_node"
  run_pi_cli_setup

  (
    cd "$work_dir"
    PI_ENV_TEST_CALLS="$calls" PI_ENV_TEST_SELECTED_SESSION="$selected_path" "$PI_BIN_DIR/pi" -r
  )
  assert_file_count "$calls" 'call' 2
  assert_file_contains "$calls" 'pwd=/'
  assert_file_contains "$calls" 'resume=1'
  assert_file_contains "$calls" 'arg2=--no-session'
  assert_file_contains "$calls" 'arg3=--no-extensions'
  assert_file_contains "$calls" 'arg4=--extension'
  assert_file_contains "$calls" "arg5=$REPO/.pi/extensions/session-resume/dist/index.js"
  assert_file_contains "$calls" "pwd=$work_dir"
  assert_file_contains "$calls" 'arg2=--session'
  assert_file_contains "$calls" "arg3=$selected_path"

  : > "$calls"
  PI_ENV_SESSION_RESUME=1 PI_ENV_SESSION_RESUME_CWD=stale PI_ENV_SESSION_RESUME_FILE=stale \
    PI_ENV_TEST_CALLS="$calls" "$PI_BIN_DIR/pi" -r extra
  assert_file_count "$calls" 'call' 1
  assert_file_contains "$calls" 'resume='
  assert_file_contains "$calls" 'arg2=-r'
  assert_file_contains "$calls" 'arg3=extra'

  : > "$calls"
  PI_ENV_TEST_CALLS="$calls" "$PI_BIN_DIR/pi" --resume
  assert_file_count "$calls" 'call' 1
  assert_file_contains "$calls" 'arg2=--no-session'

  : > "$calls"
  local failure_status
  if PI_ENV_TEST_CALLS="$calls" PI_ENV_TEST_EXIT=23 "$PI_BIN_DIR/pi" -r; then
    fail "resume picker failure should propagate"
  else
    failure_status=$?
  fi
  [ "$failure_status" -eq 23 ] || fail "resume picker failure should exit 23, got $failure_status"
  assert_file_count "$calls" 'call' 1

  unset PI_ENV_NODE_BIN
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

test_pi_cli_wrapper_adds_path_profile_when_portable() {
  local tmp old_home old_path
  tmp="$(with_temp_dir)"
  old_home="$HOME"
  old_path="$PATH"

  PI_ENV_NODE_BIN=$(node_bin)
  PI_ENV_TEST_NODE_BIN=$PI_ENV_NODE_BIN
  HOME="$tmp/home"
  PATH="/bin"
  mkdir -p "$HOME"
  create_stub_repo "$tmp"

  unset PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_CLI_MANAGED_BY_NIX PI_ENV_SKIP_PATH_PROFILE || true
  run_pi_cli_setup
  run_pi_cli_setup

  assert_file_contains "$HOME/.profile" "export PATH=\"$PI_BIN_DIR:\$PATH\""
  assert_file_count "$HOME/.profile" '# pi-env: add user-local bin to PATH' 1
  assert_file_count "$HOME/.profile" "export PATH=\"$PI_BIN_DIR:\$PATH\"" 1

  HOME="$old_home"
  PATH="$old_path"
  unset PI_ENV_NODE_BIN PI_ENV_TEST_NODE_BIN
  rm -rf "$tmp"
}

test_pi_cli_wrapper_uses_repo_locked_package
test_pi_cli_wrapper_pins_configured_node
test_pi_cli_wrapper_intercepts_exact_resume_flags
test_pi_cli_wrapper_skips_write_when_managed_by_nix
test_pi_cli_wrapper_adds_path_profile_when_portable

echo "pi CLI wrapper tests passed"
