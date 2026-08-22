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
  printf '{}\n' > "$tmp/repo/node_modules/@earendil-works/pi-coding-agent/package.json"
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

  assert_file_contains "$log" "node $tmp/repo/node_modules/@effect/language-service/cli.js patch"
  assert_file_contains "$log" "scripts/restart-lsp-daemon.sh"
  rm -rf "$tmp"
}

run_strategy nub-managed
run_strategy plain-node-bootstrap

echo "Effect language service setup tests passed"
