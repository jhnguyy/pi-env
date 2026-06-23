#!/usr/bin/env bash
# Dependency and pi CLI installation.

setup_install_dependencies() {
  section "Dependencies"
  echo "  —  installing repo dependencies with bun"
  if ! (cd "$REPO" && bun install --frozen-lockfile); then
    echo "  —  bun install failed; removing node_modules and retrying once."
    rm -rf "$REPO/node_modules"
    (cd "$REPO" && bun install --frozen-lockfile)
  fi
  ok "node_modules up to date"
}

setup_install_pi_cli() {
  section "Pi CLI"

  PI_NODE_BIN=$(resolve_setup_node_bin)
  PI_VERSION=$(cd "$REPO" && "$PI_NODE_BIN" -e "const pkg = JSON.parse(require('fs').readFileSync('./package.json', 'utf8')); console.log(pkg.devDependencies['@earendil-works/pi-coding-agent'] ?? pkg.dependencies?.['@earendil-works/pi-coding-agent']);" 2>/dev/null)
  PI_PACKAGE_DIR="$REPO/node_modules/@earendil-works/pi-coding-agent"
  PI_ENTRY="$PI_PACKAGE_DIR/dist/cli.js"
  [ -f "$PI_PACKAGE_DIR/package.json" ] || { echo "  ✗  missing pi package after install: $PI_PACKAGE_DIR" >&2; exit 1; }
  [ -f "$PI_ENTRY" ] || { echo "  ✗  missing pi entrypoint after install: $PI_ENTRY" >&2; exit 1; }

  if setup_cli_managed_externally; then
    ok "pi $PI_VERSION package installed (CLI wrapper managed externally)"
    return
  fi

  mkdir -p "$PI_BIN_DIR"
  PI_PACKAGE_DIR_LITERAL=$(printf '%s' "$PI_PACKAGE_DIR" | sed "s/'/'\\''/g")
  PI_NODE_BIN_LITERAL=$(printf '%s' "$PI_NODE_BIN" | sed "s/'/'\\''/g")
  cat > "$PI_BIN_DIR/pi" <<EOF
#!/usr/bin/env sh
set -eu

DEFAULT_PI_PACKAGE_DIR='$PI_PACKAGE_DIR_LITERAL'
REQUESTED_PI_PACKAGE_DIR="\${PI_PACKAGE_DIR:-}"
PI_PACKAGE_DIR="\$DEFAULT_PI_PACKAGE_DIR"

if [ -n "\$REQUESTED_PI_PACKAGE_DIR" ] && [ -f "\$REQUESTED_PI_PACKAGE_DIR/package.json" ] && [ -f "\$REQUESTED_PI_PACKAGE_DIR/dist/cli.js" ]; then
  PI_PACKAGE_DIR="\$REQUESTED_PI_PACKAGE_DIR"
fi

PI_ENTRY="\$PI_PACKAGE_DIR/dist/cli.js"
NODE_BIN='$PI_NODE_BIN_LITERAL'

if [ ! -x "\$NODE_BIN" ]; then
  echo "pi-env: configured Node is not executable: \$NODE_BIN" >&2
  echo "pi-env: rerun setup through nix run .#setup or set PI_ENV_NODE_BIN before setup." >&2
  exit 127
fi

if [ ! -f "\$PI_PACKAGE_DIR/package.json" ] || [ ! -f "\$PI_ENTRY" ]; then
  echo "pi-env: missing pi package install at \$PI_PACKAGE_DIR" >&2
  echo "pi-env: rerun setup.sh, or set PI_PACKAGE_DIR to a valid pi package directory." >&2
  exit 127
fi

exec "\$NODE_BIN" "\$PI_ENTRY" "\$@"
EOF
  chmod +x "$PI_BIN_DIR/pi"
  ok "pi $PI_VERSION → $PI_BIN_DIR/pi"
  if setup_external_config_managed || [ "${PI_ENV_SKIP_PATH_PROFILE:-0}" = "1" ]; then
    skip "shell profile PATH edits (managed externally)"
  elif ! echo "$PATH" | tr ':' '\n' | grep -qxF "$PI_BIN_DIR"; then
    echo "  —  $PI_BIN_DIR is not in PATH yet; updating shell profiles."
    ensure_path_in_shell_profiles "$PI_BIN_DIR"
  fi
}
