#!/usr/bin/env bash
# Shared helpers for pi-env setup scripts. Sourced by setup/main.sh.

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
  [ "${PI_ENV_SETUP_MODE:-portable}" = "nix-managed" ] || [ "${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}" = "1" ]
}

setup_external_config_managed() {
  setup_nix_managed
}

setup_cli_managed_externally() {
  [ "${PI_ENV_CLI_MANAGED_BY_NIX:-0}" = "1" ]
}

setup_node_bin_works() {
  [ -n "${1:-}" ] || return 1
  [ -x "$1" ] || return 1
  "$1" "$REPO/scripts/check-node-version.mjs" "$REPO" >/dev/null 2>&1
}

resolve_setup_node_bin() {
  if [ -n "${PI_ENV_NODE_BIN:-}" ]; then
    if [ -x "$PI_ENV_NODE_BIN" ]; then
      printf '%s\n' "$PI_ENV_NODE_BIN"
      return 0
    fi
    echo "  ✗  PI_ENV_NODE_BIN is set but not executable: $PI_ENV_NODE_BIN" >&2
    return 1
  fi

  if setup_nix_managed && command -v node >/dev/null 2>&1; then
    local path_node
    path_node=$(command -v node)
    if setup_node_bin_works "$path_node"; then
      printf '%s\n' "$path_node"
      return 0
    fi
  fi

  if command -v nub >/dev/null 2>&1; then
    local nub_node
    nub_node=$(cd "$REPO" && nub node which 2>/dev/null || true)
    if setup_node_bin_works "$nub_node"; then
      printf '%s\n' "$nub_node"
      return 0
    fi
  fi

  if command -v node >/dev/null 2>&1; then
    local path_node
    path_node=$(command -v node)
    if setup_node_bin_works "$path_node"; then
      printf '%s\n' "$path_node"
      return 0
    fi
  fi

  command -v node
}

require_node() {
  local node_bin found
  node_bin=$(resolve_setup_node_bin) || exit 1
  setup_node_bin_works "$node_bin" || {
    found=$("$node_bin" -v 2>/dev/null || echo missing)
    local required
    required=$("$node_bin" -e "const pkg = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(pkg.engines?.node ?? 'required by package.json');" "$REPO/package.json" 2>/dev/null || echo "required by package.json")
    echo "  ✗  Node.js $required is required (found: $found at $node_bin; install/provision with nub)" >&2
    exit 1
  }
}

check_required_commands() {
  local missing=0 cmd
  for cmd in "$@"; do
    if command -v "$cmd" >/dev/null 2>&1; then
      ok "$cmd"
    else
      echo "  ✗  $cmd (required; see setup/prerequisites.md)" >&2
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
      echo "  —  $cmd not found (recommended; see setup/prerequisites.md)"
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

