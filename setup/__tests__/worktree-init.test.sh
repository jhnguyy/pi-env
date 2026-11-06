#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"

# A worktree must own its dependencies: replace a shared node_modules link without
# touching the tree it points to, even when initialized from a nested directory.
test_replaces_shared_dependency_link() {
  local tmp repo shared
  tmp=$(with_temp_dir)
  repo="$tmp/repo"
  shared="$tmp/shared-node-modules"
  git init -q "$repo"
  mkdir -p "$repo/nested/path" "$shared" "$tmp/bin"
  printf '%s\n' shared > "$shared/sentinel"
  ln -s "$shared" "$repo/node_modules"
  make_executable "$tmp/bin/nub" '#!/bin/sh
[ "$1" = install ] && mkdir -p node_modules
exit 0'

  (cd "$repo/nested/path" && PATH="$tmp/bin:$PATH" quiet bash "$ROOT/scripts/init-worktree.sh")

  [ -d "$repo/node_modules" ] && [ ! -L "$repo/node_modules" ] || fail "worktree should own a local node_modules"
  assert_file_contains "$shared/sentinel" shared
}

test_replaces_shared_dependency_link

echo "worktree init tests passed"
