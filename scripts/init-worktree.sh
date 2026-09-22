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
if [ -L node_modules ]; then
  echo "Removing the shared node_modules symlink."
  rm node_modules
fi

if ! nub install --frozen-lockfile; then
  echo "Nub install failed." >&2
  exit 1
fi

nub run verify:install
echo "Worktree initialization complete."
