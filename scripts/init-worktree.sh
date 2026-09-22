#!/usr/bin/env bash
set -euo pipefail

if ! ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "Worktree initialization requires a Git checkout." >&2
  exit 1
fi
cd "$ROOT"

if [ ! -f nub.lock ]; then
  echo "Missing committed nub.lock; refusing to install dependencies." >&2
  exit 1
fi

if ! command -v nub >/dev/null 2>&1; then
  echo "Nub is required. Install the pi-env toolchain, then retry." >&2
  exit 1
fi
required_nub=$(grep -Eo '"packageManager"[[:space:]]*:[[:space:]]*"nub@[0-9]+\.[0-9]+\.[0-9]+"' package.json \
  | head -n 1 | sed -E 's/.*nub@([0-9]+\.[0-9]+\.[0-9]+)"/\1/' || true)
installed_nub=$(nub --version 2>/dev/null | head -n 1 | sed -E 's/^v//' || true)
if [ -z "$required_nub" ] || [ "$installed_nub" != "$required_nub" ]; then
  echo "Nub does not satisfy package.json#packageManager; preserving node_modules." >&2
  exit 1
fi
remove_dependency_tree() {
  if [ -L node_modules ]; then
    rm node_modules
  else
    rm -rf node_modules
  fi
}

if ! nub install --lockfile-only --ignore-scripts --frozen-lockfile; then
  echo "Nub cannot consume the committed nub.lock; preserving node_modules." >&2
  exit 1
fi

if [ -L node_modules ]; then
  echo "Removing the shared node_modules symlink."
  remove_dependency_tree
fi

install_dependencies() {
  nub install --frozen-lockfile
}

had_node_modules=0
if [ -e node_modules ]; then
  had_node_modules=1
fi

if ! install_dependencies; then
  if [ "$had_node_modules" -eq 1 ]; then
    echo "Nub install failed; preserving existing node_modules without retry." >&2
    exit 1
  fi
  echo "Nub install failed. Removing partial node_modules and retrying once." >&2
  remove_dependency_tree
  if ! install_dependencies; then
    echo "Nub install failed after the retry." >&2
    exit 1
  fi
fi

nub run verify:install
echo "Worktree initialization complete."
