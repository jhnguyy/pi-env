#!/usr/bin/env sh
# Gracefully stop the LSP daemon so the next dev-tools call spawns a fresh
# one with updated packages. Invoked automatically via the postinstall hook.
#
# Safe to run when the daemon is already stopped — all operations are no-ops.

set -e

UID_=$(id -u)
PID_FILE="/tmp/pi-lsp-${UID_}.pid"
SOCK_FILE="/tmp/pi-lsp-${UID_}.sock"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        echo "pi: LSP daemon (PID $PID) stopped — will restart on next use."
    fi
fi

rm -f "$PID_FILE" "$SOCK_FILE"
