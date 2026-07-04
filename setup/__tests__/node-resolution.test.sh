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

test_node_run_honors_valid_pi_env_node_bin() {
  local output
  output="$(PI_ENV_NODE_BIN="$(real_node_bin)" "$ROOT/scripts/node-run.sh" -e 'console.log(process.argv[1])' ok)"
  [ "$output" = "ok" ] || fail "node-run should execute with PI_ENV_NODE_BIN, got $output"
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

test_uses_working_nub_node_first() {
  local tmp old_path resolved
  tmp="$(with_temp_dir)"
  old_path="$PATH"
  REPO="$tmp/repo"
  mkdir -p "$REPO" "$tmp/bin"

  make_fake_node "$tmp/nub-node" 0
  make_fake_node "$tmp/bin/node" 0
  make_fake_nub "$tmp/bin/nub" "$tmp/nub-node"

  PATH="$tmp/bin:$PATH"
  unset PI_ENV_NODE_BIN PI_ENV_SETUP_MODE PI_ENV_CONFIG_MANAGED_BY_NIX || true
  resolved="$(resolve_setup_node_bin)"
  [ "$resolved" = "$tmp/nub-node" ] || fail "expected working Nub node, got $resolved"

  PATH="$old_path"
  rm -rf "$tmp"
}

test_node_run_honors_valid_pi_env_node_bin
test_node_run_rejects_invalid_pi_env_node_bin
test_falls_back_when_nub_node_is_broken
test_uses_working_nub_node_first

echo "node resolution tests passed"
