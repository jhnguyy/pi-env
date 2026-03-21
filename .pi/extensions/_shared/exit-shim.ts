/**
 * @module _shared/exit-shim
 * @purpose Bus exit-signal shell shim. Use when spawning a pane with busChannel.
 *
 * Lazily writes a bash script to /tmp that publishes a bus exit signal.
 * Called by tmux pane teardown so the orchestrator gets notified even if
 * the worker process crashes.
 *
 * @example
 *   ensureExitShim();  // idempotent — writes /tmp/pi-bus-exit-shim once
 */

import { writeFileSync, existsSync } from "node:fs";

export const SHIM_PATH = "/tmp/pi-bus-exit-shim";

export const SHIM_SCRIPT = [
  "#!/usr/bin/env bash",
  'CHANNEL="$1"',
  'SESSION="${PI_BUS_SESSION:-}"',
  '[ -n "$SESSION" ] || exit 0',
  'DIR="/tmp/pi-bus-${SESSION}/channels/${CHANNEL}"',
  'mkdir -p "$DIR" 2>/dev/null',
  'TS=$(date +%s)000',
  'RAND=$(od -An -N2 -tx1 /dev/urandom 2>/dev/null | tr -dc a-f0-9 | head -c4 || printf "%04x" 0)',
  'FINAL="$DIR/${TS}-exit-${RAND}.json"',
  'printf \'{"channel":"%s","sender":"exit","timestamp":%s,"type":"status","message":"process exited"}\' "$CHANNEL" "$TS" > "${FINAL}.tmp" && mv "${FINAL}.tmp" "$FINAL"',
].join("\n");

export function ensureExitShim(): void {
  if (existsSync(SHIM_PATH)) return;
  writeFileSync(SHIM_PATH, SHIM_SCRIPT, { mode: 0o755 });
}
