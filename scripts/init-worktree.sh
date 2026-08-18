#!/usr/bin/env bash
set -euo pipefail

if ! ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "Worktree initialization requires a Git checkout." >&2
  exit 1
fi
cd "$ROOT"

if ! command -v nub >/dev/null 2>&1; then
  echo "Nub is required. Install the pi-env toolchain, then retry." >&2
  exit 1
fi

remove_dependency_tree() {
  if [ -L node_modules ]; then
    rm node_modules
  else
    rm -rf node_modules
  fi
}

if [ -L node_modules ]; then
  echo "Removing the shared node_modules symlink."
  remove_dependency_tree
fi

install_dependencies() {
  nub install --frozen-lockfile
}

if ! install_dependencies; then
  echo "Nub install failed. Removing node_modules and retrying once." >&2
  remove_dependency_tree
  if ! install_dependencies; then
    echo "Nub install failed after the retry." >&2
    exit 1
  fi
fi

nub run verify:install
echo "Worktree initialization complete."
