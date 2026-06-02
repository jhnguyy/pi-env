#!/usr/bin/env bash
# Dependency and pi CLI installation.

setup_install_dependencies() {
  section "Dependencies"
  echo "  —  installing repo dependencies, including optional native packages"
  if ! (cd "$REPO" && npm ci --no-audit --include=dev --include=optional); then
    echo "  —  npm ci failed; removing node_modules and retrying once."
    rm -rf "$REPO/node_modules"
    (cd "$REPO" && npm ci --no-audit --include=dev --include=optional)
  fi
  ok "node_modules up to date"
}

setup_install_pi_cli() {
  section "Pi CLI"

  PI_VERSION=$(cd "$REPO" && node -e "const pkg = JSON.parse(require('fs').readFileSync('./package.json', 'utf8')); console.log(pkg.devDependencies['@earendil-works/pi-coding-agent'] ?? pkg.dependencies?.['@earendil-works/pi-coding-agent']);" 2>/dev/null)
  PI_PKG_SPEC="@earendil-works/pi-coding-agent@$PI_VERSION"
  mkdir -p "$PI_BIN_DIR" "$PI_CLI_ROOT"
  rm -rf "$PI_CLI_ROOT/node_modules" "$PI_CLI_ROOT/package-lock.json"
  npm install --prefix "$PI_CLI_ROOT" "$PI_PKG_SPEC" --no-audit --include=optional

  PI_PACKAGE_DIR="$PI_CLI_ROOT/node_modules/@earendil-works/pi-coding-agent"
  PI_ENTRY="$PI_PACKAGE_DIR/dist/cli.js"
  [ -f "$PI_PACKAGE_DIR/package.json" ] || { echo "  ✗  missing pi package after install: $PI_PACKAGE_DIR" >&2; exit 1; }
  [ -f "$PI_ENTRY" ] || { echo "  ✗  missing pi entrypoint after install: $PI_ENTRY" >&2; exit 1; }

  PI_CLI_ROOT_LITERAL=$(printf '%s' "$PI_CLI_ROOT" | sed "s/'/'\\''/g")
  cat > "$PI_BIN_DIR/pi" <<EOF
#!/usr/bin/env sh
set -eu

DEFAULT_PI_CLI_ROOT='$PI_CLI_ROOT_LITERAL'
PI_CLI_ROOT="\${PI_CLI_ROOT:-\$DEFAULT_PI_CLI_ROOT}"
PI_PACKAGE_DIR="\$PI_CLI_ROOT/node_modules/@earendil-works/pi-coding-agent"
PI_ENTRY="\$PI_PACKAGE_DIR/dist/cli.js"

if [ ! -f "\$PI_PACKAGE_DIR/package.json" ] || [ ! -f "\$PI_ENTRY" ]; then
  echo "pi-env: missing pi package install at \$PI_PACKAGE_DIR" >&2
  echo "pi-env: rerun setup.sh, or set PI_CLI_ROOT to the install prefix." >&2
  exit 127
fi

exec node "\$PI_ENTRY" "\$@"
EOF
  chmod +x "$PI_BIN_DIR/pi"
  ok "pi $PI_VERSION → $PI_BIN_DIR/pi"
  if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$PI_BIN_DIR"; then
    echo "  —  $PI_BIN_DIR is not in PATH yet; add it to your shell profile."
  fi
}
