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

require_node() {
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1);" 2>/dev/null || {
    echo "  ✗  Node.js >= 22.19 is required (found: $(node -v 2>/dev/null || echo missing))" >&2
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
