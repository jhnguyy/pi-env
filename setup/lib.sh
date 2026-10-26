#!/usr/bin/env bash
# Shared helpers for pi-env setup scripts. Sourced by setup/main.sh.
# shellcheck source=setup/node-runtime.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/node-runtime.sh"

ok() { echo "  ✓  $1"; }

section() {
  local title="$1" underline=""
  local i=0
  echo ""
  echo "$title"
  while [ "$i" -lt "${#title}" ]; do
    underline="${underline}-"
    i=$((i + 1))
  done
  printf '%s\n' "$underline"
}

setup_node_bin_works() {
  pi_env_node_candidate_works "${1:-}" "$REPO"
}

resolve_setup_node_bin() {
  pi_env_select_node_bin "$REPO"
}

require_node() {
  local node_bin
  node_bin=$(resolve_setup_node_bin) || exit 1
  setup_node_bin_works "$node_bin" || exit 1
}

check_required_commands() {
  local missing=0 cmd
  for cmd in "$@"; do
    if command -v "$cmd" >/dev/null 2>&1; then
      ok "$cmd"
    else
      echo "  ✗  $cmd (required; see docs/prerequisites.md)" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || exit 1
}

check_recommended_commands() {
  local cmd
  for cmd in "$@"; do
    if command -v "$cmd" >/dev/null 2>&1; then
      ok "$cmd"
    else
      echo "  —  $cmd not found (recommended; see docs/prerequisites.md)"
    fi
  done
}
