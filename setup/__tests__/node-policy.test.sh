#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
NODE=$(node_bin)
VERSION=$("$NODE" -p process.versions.node)
MAJOR=${VERSION%%.*}
REPO=$(with_temp_dir)

# check-node-version.mjs reads engines.node from the repository it is given.
check_range() {
  printf '{"engines":{"node":"%s"}}\n' "$1" > "$REPO/package.json"
  "$NODE" "$ROOT/scripts/check-node-version.mjs" "$REPO" >/dev/null 2>&1
}

check_range ">=$VERSION" || fail "the minimum runtime should pass"
check_range ">=$((MAJOR - 1)).0.0" || fail "a newer compatible runtime should pass"
! check_range ">=$((MAJOR + 1)).0.0" || fail "a too-old runtime should fail"
! check_range "^$MAJOR.0.0" || fail "an unsupported range policy should fail"
echo "node policy tests passed"
