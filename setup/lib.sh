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

resolve_setup_node_bin() {
  if [ -n "${PI_ENV_NODE_BIN:-}" ]; then
    if [ -x "$PI_ENV_NODE_BIN" ]; then
      printf '%s\n' "$PI_ENV_NODE_BIN"
      return 0
    fi
    echo "  ✗  PI_ENV_NODE_BIN is set but not executable: $PI_ENV_NODE_BIN" >&2
    return 1
  fi

  if setup_nix_managed; then
    if [ -x "$HOME/.nix-profile/bin/node" ]; then
      printf '%s\n' "$HOME/.nix-profile/bin/node"
      return 0
    fi
    if [ -x /run/current-system/sw/bin/node ]; then
      printf '%s\n' /run/current-system/sw/bin/node
      return 0
    fi
  fi

  command -v node
}

require_node() {
  local node_bin found
  node_bin=$(resolve_setup_node_bin) || exit 1
  "$node_bin" -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1);" 2>/dev/null || {
    found=$("$node_bin" -v 2>/dev/null || echo missing)
    echo "  ✗  Node.js >= 22.19 is required (found: $found at $node_bin)" >&2
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

profile_has_path_entry() {
  local profile="$1" bin_dir="$2" marker="$3"
  [ -e "$profile" ] || return 1
  grep -qF "$marker" "$profile" && return 0
  grep -qF "$bin_dir" "$profile" && grep -qF 'PATH' "$profile" && return 0
  if [ "$bin_dir" = "$HOME/.local/bin" ]; then
    grep -Eq '(\$HOME|~)/\.local/bin' "$profile" && grep -qF 'PATH' "$profile" && return 0
  fi
  return 1
}

append_path_entry_once() {
  local profile="$1" bin_dir="$2" marker="$3" label="$4" path_expr
  if profile_has_path_entry "$profile" "$bin_dir" "$marker"; then
    ok "$label (PATH entry already present)"
    return
  fi

  if [ "$bin_dir" = "$HOME/.local/bin" ]; then
    path_expr='export PATH="$HOME/.local/bin:$PATH"'
  else
    path_expr="export PATH=\"$bin_dir:\$PATH\""
  fi

  if [ -e "$profile" ]; then
    printf '\n%s\n%s\n' "$marker" "$path_expr" >> "$profile"
    ok "$label (appended PATH entry)"
  else
    printf '%s\n%s\n' "$marker" "$path_expr" > "$profile"
    ok "$label (created with PATH entry)"
  fi
}

ensure_path_in_shell_profiles() {
  local bin_dir="$1" marker="# pi-env: add user-local bin to PATH"
  local profiles=() profile configured=0

  for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    if profile_has_path_entry "$profile" "$bin_dir" "$marker"; then
      ok "$profile already configures $bin_dir"
      configured=1
    elif [ -e "$profile" ]; then
      profiles+=("$profile")
    fi
  done

  if [ "${#profiles[@]}" -eq 0 ] && [ "$configured" -eq 0 ]; then
    profiles=("$HOME/.profile")
  fi

  for profile in "${profiles[@]}"; do
    append_path_entry_once "$profile" "$bin_dir" "$marker" "$profile"
  done
}
