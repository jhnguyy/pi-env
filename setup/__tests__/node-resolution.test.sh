#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
# shellcheck source=setup/lib.sh
source "$ROOT/setup/lib.sh"

make_fake_node() {
  local path="$1" exit_code="${2:-0}"
  cat > "$path" <<SH
#!/usr/bin/env sh
if [ "$exit_code" != "0" ]; then
  exit $exit_code
fi
printf 'fake node\n'
SH
  chmod +x "$path"
}

make_fake_nub() {
  local path="$1" node_path="$2"
  cat > "$path" <<SH
#!/usr/bin/env sh
if [ "\${1:-}" = "node" ] && [ "\${2:-}" = "which" ]; then
  printf '%s\n' '$node_path'
  exit 0
fi
exit 1
SH
  chmod +x "$path"
}

real_node_bin() {
  node_bin
}

test_node_run_honors_valid_node_executable() {
  local output
  output="$(NODE_EXECUTABLE="$(real_node_bin)" "$ROOT/scripts/node-run.sh" -e 'console.log(process.argv[1])' ok)"
  [ "$output" = "ok" ] || fail "node-run should execute with NODE_EXECUTABLE, got $output"
}

test_node_run_honors_valid_pi_env_node_bin() {
  local output
  output="$(PI_ENV_NODE_BIN="$(real_node_bin)" "$ROOT/scripts/node-run.sh" -e 'console.log(process.argv[1])' ok)"
  [ "$output" = "ok" ] || fail "node-run should execute with PI_ENV_NODE_BIN, got $output"
}

test_pi_env_node_bin_precedes_invalid_node_executable() {
  local tmp output
  tmp="$(with_temp_dir)"
  cat > "$tmp/not-node" <<'SH'
#!/usr/bin/env sh
exit 127
SH
  chmod +x "$tmp/not-node"
  output="$(
    NODE_EXECUTABLE="$tmp/not-node" \
      PI_ENV_NODE_BIN="$(real_node_bin)" \
      "$ROOT/scripts/node-run.sh" -e 'console.log(process.argv[1])' ok
  )"
  [ "$output" = "ok" ] || fail "PI_ENV_NODE_BIN should precede invalid NODE_EXECUTABLE, got $output"
  rm -rf "$tmp"
}

test_invalid_node_executable_falls_back_to_nub_node() {
  local tmp old_path resolved
  tmp="$(with_temp_dir)"
  old_path="$PATH"
  REPO="$tmp/repo"
  mkdir -p "$REPO" "$tmp/bin"
  make_fake_node "$tmp/nub-node" 0
  make_fake_node "$tmp/not-node" 127
  make_fake_nub "$tmp/bin/nub" "$tmp/nub-node"

  PATH="$tmp/bin:$PATH"
  resolved="$(
    PI_ENV_NODE_BIN= \
      NODE_EXECUTABLE="$tmp/not-node" \
      resolve_setup_node_bin
  )"
  [ "$resolved" = "$tmp/nub-node" ] || fail "invalid NODE_EXECUTABLE should fall back to Nub Node, got $resolved"

  PATH="$old_path"
  rm -rf "$tmp"
}

test_node_run_rejects_invalid_pi_env_node_bin() {
  local tmp output status
  tmp="$(with_temp_dir)"
  cat > "$tmp/not-node" <<'SH'
#!/usr/bin/env sh
exit 127
SH
  chmod +x "$tmp/not-node"
  set +e
  output="$(PI_ENV_NODE_BIN="$tmp/not-node" "$ROOT/scripts/node-run.sh" -e 'console.log(1)' 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 127 ] || fail "node-run should reject invalid PI_ENV_NODE_BIN with 127, got $status"
  printf '%s' "$output" | grep -q 'PI_ENV_NODE_BIN is not usable' || fail "node-run should explain invalid PI_ENV_NODE_BIN"
  rm -rf "$tmp"
}

test_tool_node_run_enforces_tool_runtime_range() {
  local tmp output status
  tmp="$(with_temp_dir)"
  cat > "$tmp/supported-node" <<'SH'
#!/usr/bin/env sh
if [ "${1:-}" = "-p" ]; then printf '22.12.0\n'; exit 0; fi
printf 'tool:%s\n' "$*"
SH
  cat > "$tmp/unsupported-node" <<'SH'
#!/usr/bin/env sh
if [ "${1:-}" = "-p" ]; then printf '22.11.0\n'; exit 0; fi
printf 'unexpected tool execution\n'
SH
  chmod +x "$tmp/supported-node" "$tmp/unsupported-node"

  output="$(PI_ENV_TOOL_NODE="$tmp/supported-node" "$ROOT/scripts/tool-node-run.sh" tool-script --check)"
  [ "$output" = "tool:tool-script --check" ] || fail "tool-node-run should execute a supported host Node, got $output"

  set +e
  output="$(PI_ENV_TOOL_NODE="$tmp/unsupported-node" "$ROOT/scripts/tool-node-run.sh" tool-script 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "tool-node-run should reject Node 22.11, got $status"
  printf '%s' "$output" | grep -q 'must be executable and satisfy' || fail "tool-node-run should explain its runtime range"
  rm -rf "$tmp"
}

test_falls_back_when_nub_node_is_broken() {
  local tmp old_path resolved
  tmp="$(with_temp_dir)"
  old_path="$PATH"
  REPO="$tmp/repo"
  mkdir -p "$REPO" "$tmp/bin"

  make_fake_node "$tmp/broken-node" 127
  make_fake_node "$tmp/bin/node" 0
  make_fake_nub "$tmp/bin/nub" "$tmp/broken-node"

  PATH="$tmp/bin:$PATH"
  unset PI_ENV_NODE_BIN PI_ENV_SETUP_MODE PI_ENV_CONFIG_MANAGED_BY_NIX || true
  resolved="$(resolve_setup_node_bin)"
  [ "$resolved" = "$tmp/bin/node" ] || fail "expected PATH node fallback, got $resolved"

  PATH="$old_path"
  rm -rf "$tmp"
}

test_prefers_nub_node_before_path_node() {
  local tmp old_path resolved
  tmp="$(with_temp_dir)"
  old_path="$PATH"
  REPO="$tmp/repo"
  mkdir -p "$REPO" "$tmp/bin"

  make_fake_node "$tmp/nub-node" 0
  make_fake_node "$tmp/bin/node" 0
  make_fake_nub "$tmp/bin/nub" "$tmp/nub-node"

  PATH="$tmp/bin:$PATH"
  unset NODE_EXECUTABLE PI_ENV_NODE_BIN PI_ENV_SETUP_MODE PI_ENV_CONFIG_MANAGED_BY_NIX || true
  resolved="$(resolve_setup_node_bin)"
  [ "$resolved" = "$tmp/nub-node" ] || fail "expected Nub node before PATH node, got $resolved"

  PATH="$old_path"
  rm -rf "$tmp"
}

test_no_node_points_to_nix_next_step_when_nix_exists() {
  local tmp old_path output status
  tmp="$(with_temp_dir)"
  old_path="$PATH"
  REPO="$tmp/repo"
  mkdir -p "$REPO" "$tmp/bin"
  cat > "$tmp/bin/nix" <<'SH'
#!/usr/bin/env sh
exit 0
SH
  chmod +x "$tmp/bin/nix"
  PATH="$tmp/bin"
  unset PI_ENV_NODE_BIN PI_ENV_SETUP_MODE PI_ENV_CONFIG_MANAGED_BY_NIX || true
  set +e
  output="$(resolve_setup_node_bin 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 127 ] || fail "expected missing node to exit 127, got $status"
  case "$output" in
    *'./setup.sh --use-nix'*) ;;
    *) fail "missing node should point to nix setup next step" ;;
  esac
  PATH="$old_path"
  rm -rf "$tmp"
}

test_node_run_honors_valid_node_executable
test_node_run_honors_valid_pi_env_node_bin
test_pi_env_node_bin_precedes_invalid_node_executable
test_invalid_node_executable_falls_back_to_nub_node
test_node_run_rejects_invalid_pi_env_node_bin
test_tool_node_run_enforces_tool_runtime_range
test_falls_back_when_nub_node_is_broken
test_prefers_nub_node_before_path_node
test_no_node_points_to_nix_next_step_when_nix_exists

echo "node resolution tests passed"
