#!/usr/bin/env sh
# Postinstall stops the daemon so the next request loads the rebuilt bundle; missing artifacts are safe.

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
