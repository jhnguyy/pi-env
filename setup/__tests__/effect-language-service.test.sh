#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

run_strategy() {
  local strategy="$1" tmp fake_bin log setup_node
  tmp="$(with_temp_dir)"
  fake_bin="$tmp/bin"
  log="$tmp/commands.log"
  setup_node="$fake_bin/setup-node"
  mkdir -p \
    "$fake_bin" \
    "$tmp/repo/node_modules/@effect/language-service" \
    "$tmp/repo/node_modules/@earendil-works/pi-coding-agent/dist" \
    "$tmp/repo/scripts" \
    "$tmp/pi-bin"

  cat > "$tmp/repo/package.json" <<'JSON'
{
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.0.0",
    "@effect/language-service": "1.0.0"
  }
}
JSON
  printf '{"bin":{"pi":"dist/cli.js"}}\n' > "$tmp/repo/node_modules/@earendil-works/pi-coding-agent/package.json"
  : > "$tmp/repo/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
  : > "$tmp/repo/node_modules/@effect/language-service/cli.js"
  cat > "$tmp/repo/scripts/restart-lsp-daemon.sh" <<'SH'
#!/usr/bin/env sh
printf 'sh scripts/restart-lsp-daemon.sh\n' >> "$COMMAND_LOG"
SH

  cat > "$fake_bin/nub" <<'SH'
#!/usr/bin/env sh
printf 'nub %s\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  "run --silent check:node")
    [ "$INSTALL_STRATEGY" = "nub-managed" ]
    ;;
  "run --node --ignore-scripts --silent check:node")
    [ "$INSTALL_STRATEGY" = "plain-node-bootstrap" ]
    ;;
  install\ *|"run build")
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
SH
  cat > "$setup_node" <<'SH'
#!/usr/bin/env sh
printf 'node %s\n' "$*" >> "$COMMAND_LOG"
exit 0
SH
  chmod +x "$fake_bin/nub" "$setup_node"

  PATH="$fake_bin:$PATH" \
    COMMAND_LOG="$log" \
    INSTALL_STRATEGY="$strategy" \
    REPO="$tmp/repo" \
    PI_BIN_DIR="$tmp/pi-bin" \
    PI_ENV_CLI_MANAGED_BY_NIX=1 \
    PI_ENV_CONFIG_MANAGED_BY_NIX=1 \
    "$(node_bin)" "$ROOT/setup/runtime.mjs" "$setup_node" all >/dev/null

  assert_file_contains "$log" "node $tmp/repo/scripts/patch-effect-language-service.mjs $setup_node"
  assert_file_contains "$log" "scripts/restart-lsp-daemon.sh"
  rm -rf "$tmp"
}

assert_output_excludes_patch_notes() {
  local output_file="$1" unexpected
  for unexpected in \
    "is already patched" \
    "If your project uses incremental builds" \
    "No prepare script found"; do
    if grep -qF "$unexpected" "$output_file"; then
      fail "$output_file contains unexpected patch note: $unexpected"
    fi
  done
}

test_patch_helper_patches_once_then_stays_quiet() {
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
  if grep -qF "No prepare script found" "$first_log"; then
    fail "Effect language service did not recognize package.json#scripts.prepare"
  fi
  assert_file_contains "$target/lib/typescript.js" "$patch_marker"
  assert_file_contains "$target/lib/_tsc.js" "$patch_marker"

  if ! (cd "$tmp/repo" && "$node" "$ROOT/scripts/patch-effect-language-service.mjs" "$node") >"$second_log" 2>&1; then
    fail "Effect TypeScript patch rerun failed: $(cat "$second_log")"
  fi
  assert_output_excludes_patch_notes "$second_log"
  rm -rf "$tmp"
}

run_strategy nub-managed
run_strategy plain-node-bootstrap
test_patch_helper_patches_once_then_stays_quiet

echo "Effect language service setup tests passed"
