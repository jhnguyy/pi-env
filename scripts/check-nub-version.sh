#!/usr/bin/env sh
set -eu

repo="${1:-$(pwd)}"
manifest="$repo/package.json"
required="$(sed -nE 's/.*"packageManager"[[:space:]]*:[[:space:]]*"nub@([^"]+)".*/\1/p' "$manifest" | head -n 1)"
if [ -z "$required" ]; then
  echo "pi-env: package.json must declare an exact nub packageManager version." >&2
  exit 1
fi

actual="$(nub --version 2>/dev/null | head -n 1)"
actual="${actual#v}"
if [ "$actual" != "$required" ]; then
  echo "pi-env: Nub $required is required; found ${actual:-unknown}." >&2
  echo "Run \`nub upgrade\`, or enter the pinned pi-env Nix toolchain, then retry." >&2
  exit 1
fi
