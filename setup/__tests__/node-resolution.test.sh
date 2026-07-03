#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=setup/lib.sh
source "$ROOT/setup/lib.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_fake_node() {
  local path="$1" exit_code="${2:-0}"
  cat > "$path" <<SH
#!/usr/bin/env sh
if [ "\${1:-}" = "-e" ]; then
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

test_falls_back_when_nub_node_is_broken() {
  local tmp old_path resolved
  tmp="$(mktemp -d)"
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
  tmp="$(mktemp -d)"
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

test_falls_back_when_nub_node_is_broken
test_uses_working_nub_node_first

echo "node resolution tests passed"
