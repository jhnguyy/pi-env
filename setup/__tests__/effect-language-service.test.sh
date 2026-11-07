#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

test_patch_helper_patches_and_reruns() {
  local cli node patch_marker target tmp version
  tmp="$(with_temp_dir)"
  cli="$ROOT/node_modules/@effect/language-service/cli.js"
  node="$(node_bin)"
  target="$tmp/repo/node_modules/typescript"
  mkdir -p "$tmp/repo/node_modules/@effect"
  cp "$ROOT/package.json" "$tmp/repo/package.json"
  cp -RL "$ROOT/node_modules/typescript" "$target"
  ln -s "$ROOT/node_modules/@effect/language-service" "$tmp/repo/node_modules/@effect/language-service"

  "$node" "$cli" unpatch --dir "$target" --module tsc --log-level none
  "$node" "$cli" patch --dir "$target" --module typescript --log-level none
  version="$("$node" -p "require('$ROOT/node_modules/@effect/language-service/package.json').version")"
  patch_marker="\"use effect-lsp-patch-version $version\";"
  assert_file_contains "$target/lib/typescript.js" "$patch_marker"
  if grep -qF "$patch_marker" "$target/lib/_tsc.js"; then
    fail 'fixture compiler must be unpatched before running the patch helper'
  fi
  (cd "$tmp/repo" && PI_ENV_NODE_BIN="$tmp/not-node" NODE_EXECUTABLE="$tmp/not-node" \
    quiet "$node" "$ROOT/scripts/patch-effect-language-service.mjs" "$node") || fail "Effect TypeScript patch failed"
  assert_file_contains "$target/lib/typescript.js" "$patch_marker"
  assert_file_contains "$target/lib/_tsc.js" "$patch_marker"

  (cd "$tmp/repo" && quiet "$node" "$ROOT/scripts/patch-effect-language-service.mjs" "$node") ||
    fail "Effect TypeScript patch rerun failed"
  assert_file_contains "$target/lib/typescript.js" "$patch_marker"
  assert_file_contains "$target/lib/_tsc.js" "$patch_marker"
}

test_patch_helper_patches_and_reruns

echo "Effect language service setup tests passed"
