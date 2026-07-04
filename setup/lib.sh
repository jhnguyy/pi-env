#!/usr/bin/env bash
# Shared helpers for pi-env setup scripts. Sourced by setup/main.sh.
# shellcheck source=setup/node-runtime.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/node-runtime.sh"

ok()     { echo "  ✓  $1"; }
linked() { echo "  →  $1"; }
skip()   { echo "  —  $1 (exists locally, skipping)"; }
relink() { echo "  ↺  $1 (relinked)"; }

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

setup_nix_managed() {
  pi_env_setup_nix_managed
}

setup_external_config_managed() {
  setup_nix_managed
}

setup_cli_managed_externally() {
  [ "${PI_ENV_CLI_MANAGED_BY_NIX:-0}" = "1" ]
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

link_path() {
  local src="$1" target="$2" label="$3"
  if [ -L "$target" ]; then
    [ "$(readlink "$target")" = "$src" ] && ok "$label" && return
    ln -sfn "$src" "$target" && relink "$label"
  elif [ -e "$target" ]; then
    skip "$label"
  else
    ln -sfn "$src" "$target" && linked "$label"
  fi
}

link_entries() {
  local entry src target label
  for entry in "$@"; do
    IFS='|' read -r src target label <<EOF
$entry
EOF
    link_path "$src" "$target" "$label"
  done
}

append_once() {
  local src="$1" dst="$2" marker="$3" label="$4"
  if [ ! -e "$dst" ]; then
    printf '%s\n' "$marker" > "$dst"
    cat "$src" >> "$dst"
    ok "$label (created with repo block)"
  elif grep -qF "$marker" "$dst"; then
    ok "$label (repo block already present)"
  else
    printf '\n%s\n' "$marker" >> "$dst"
    cat "$src" >> "$dst"
    ok "$label (appended repo block)"
  fi
}

