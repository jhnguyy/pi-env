#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

tmp="$(with_temp_dir)"
trap 'rm -rf "$tmp"' EXIT
node="$(node_bin)"
repo="$tmp/repo"
mkdir -p "$repo/node_modules/@typescript" "$repo/node_modules/@effect" "$repo/scripts"
cp -RL "$ROOT/node_modules/@typescript/native" "$repo/node_modules/@typescript/native"
platform_package="$("$node" -p '"@typescript/typescript-" + process.platform + "-" + process.arch')"
platform_root="$("$node" -e 'const { createRequire } = require("node:module"); const { dirname } = require("node:path"); const r = createRequire(require.resolve("@typescript/native/package.json")); console.log(dirname(r.resolve(process.argv[1] + "/package.json")))' "$platform_package")"
cp -RL "$platform_root" "$repo/node_modules/$platform_package"
ln -s "$ROOT/node_modules/@effect/tsgo" "$repo/node_modules/@effect/tsgo"
cli="$ROOT/node_modules/@effect/tsgo/dist/effect-tsgo.cjs"
for script in extension-manifest extension-contract package-contract install-contract verify-install; do
  cp "$ROOT/scripts/$script.mjs" "$repo/scripts/"
done
printf '%s\n' '{"workspaces":[],"pi":{"extensions":[]},"devDependencies":{"@effect/tsgo":"0.56.0"}}' > "$repo/package.json"
printf '%s\n' '{"extensionsDir":".pi/extensions"}' > "$repo/pi-build.config.json"
mkdir -p "$repo/.pi/extensions"

(cd "$repo" && "$node" "$cli" unpatch --typescript --typescript-package @typescript/native) > "$tmp/unpatch.log" 2>&1
if (cd "$repo" && "$node" scripts/verify-install.mjs) > "$tmp/unpatched.log" 2>&1; then
  fail "Unpatched native TypeScript installation was accepted"
fi
assert_file_contains "$tmp/unpatched.log" "Effect TypeScript patch check failed"

for attempt in first second; do
  if ! (cd "$repo" && PI_ENV_NODE_BIN="$tmp/not-node" NODE_EXECUTABLE="$tmp/not-node" \
    "$node" "$ROOT/scripts/patch-effect-language-service.mjs" "$node") > "$tmp/$attempt.log" 2>&1; then
    fail "Native Effect TypeScript patch failed: $(cat "$tmp/$attempt.log")"
  fi
  (cd "$repo" && "$node" scripts/verify-install.mjs) > "$tmp/verified.log" 2>&1
  assert_file_contains "$tmp/verified.log" "Install readiness check passed"
done

echo "Native Effect TypeScript setup tests passed"
