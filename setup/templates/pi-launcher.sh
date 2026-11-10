# Runtime dispatch only; installation supplies the executable and checkout paths.
REQUESTED_PI_PACKAGE_DIR="${PI_PACKAGE_DIR:-}"
PI_PACKAGE_DIR="$DEFAULT_PI_PACKAGE_DIR"
if [ -z "$PI_EXECUTABLE" ] && [ -n "$REQUESTED_PI_PACKAGE_DIR" ] && [ -f "$REQUESTED_PI_PACKAGE_DIR/package.json" ] && [ -f "$REQUESTED_PI_PACKAGE_DIR/$PI_PACKAGE_ENTRY" ]; then
  PI_PACKAGE_DIR="$REQUESTED_PI_PACKAGE_DIR"
fi
PI_ENTRY="$PI_PACKAGE_DIR/$PI_PACKAGE_ENTRY"
export PI_ENV_NODE_BIN="$NODE_BIN"
if [ -z "${PI_CODING_AGENT_DIR:-}" ] && [ -n "${PI_AGENT_DIR:-}" ]; then
  export PI_CODING_AGENT_DIR="$PI_AGENT_DIR"
fi
if [ -n "$PI_EXECUTABLE" ] && [ ! -x "$PI_EXECUTABLE" ]; then
  echo "pi-env: configured Pi executable is unavailable: $PI_EXECUTABLE" >&2
  exit 127
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "pi-env: configured Node is not executable: $NODE_BIN" >&2
  echo "pi-env: rerun setup through nix run .#setup or set PI_ENV_NODE_BIN before setup." >&2
  exit 127
fi
if [ -z "$PI_EXECUTABLE" ] && { [ ! -f "$PI_PACKAGE_DIR/package.json" ] || [ ! -f "$PI_ENTRY" ]; }; then
  echo "pi-env: missing pi package install at $PI_PACKAGE_DIR" >&2
  echo "pi-env: rerun setup.sh, or set PI_PACKAGE_DIR to a valid pi package directory." >&2
  exit 127
fi
if [ "$#" -eq 1 ] && [ "$1" = "--start" ] && [ "${PI_ENV_SESSION_MANAGER_BYPASS:-}" != "1" ]; then
  if [ ! -f "$SESSION_MANAGER_START" ] || [ ! -f "$SESSION_MANAGER_EXTENSION" ]; then
    echo "pi-env: session manager build is missing. Rerun setup." >&2
    exit 127
  fi
  PI_ENV_PI_WRAPPER="$INSTALLED_PI_WRAPPER" \
  PI_ENV_SESSION_MANAGER_EXTENSION="$SESSION_MANAGER_EXTENSION" \
  PI_NODE_ARGV0=pi exec "$NODE_BIN" "$SESSION_MANAGER_START"
fi
if [ -n "$PI_EXECUTABLE" ]; then
  exec "$PI_EXECUTABLE" "$@"
fi
PI_NODE_ARGV0=pi exec "$NODE_BIN" "$PI_ENTRY" "$@"
