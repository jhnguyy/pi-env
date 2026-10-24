#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

test_patch_helper_patches_and_reruns() {
  local cli first_log node patch_marker second_log target tmp version
  tmp="$(with_temp_dir)"
  cli="$ROOT/node_modules/@effect/language-service/cli.js"
  node="$(node_bin)"
  target="$tmp/repo/node_modules/typescript"
  first_log="$tmp/first-patch.log"
  second_log="$tmp/second-patch.log"
  mkdir -p "$tmp/repo/node_modules/@effect"
  cp "$ROOT/package.json" "$tmp/repo/package.json"
  cp -RL "$ROOT/node_modules/typescript" "$target"
  ln -s "$ROOT/node_modules/@effect/language-service" "$tmp/repo/node_modules/@effect/language-service"

  "$node" "$cli" unpatch --dir "$target" --log-level none
  "$node" "$cli" patch --dir "$target" --module typescript --log-level none
  version="$("$node" -p "require('$ROOT/node_modules/@effect/language-service/package.json').version")"
  patch_marker="\"use effect-lsp-patch-version $version\";"
  if ! (cd "$tmp/repo" && PI_ENV_NODE_BIN="$tmp/not-node" NODE_EXECUTABLE="$tmp/not-node" \
    "$node" "$ROOT/scripts/patch-effect-language-service.mjs" "$node") >"$first_log" 2>&1; then
    fail "Effect TypeScript patch failed: $(cat "$first_log")"
  fi
  assert_file_contains "$target/lib/typescript.js" "$patch_marker"
  assert_file_contains "$target/lib/_tsc.js" "$patch_marker"

  if ! (cd "$tmp/repo" && "$node" "$ROOT/scripts/patch-effect-language-service.mjs" "$node") >"$second_log" 2>&1; then
    fail "Effect TypeScript patch rerun failed: $(cat "$second_log")"
  fi
  assert_file_contains "$target/lib/typescript.js" "$patch_marker"
  assert_file_contains "$target/lib/_tsc.js" "$patch_marker"
  rm -rf "$tmp"
}

test_patch_helper_patches_and_reruns

echo "Effect language service setup tests passed"
