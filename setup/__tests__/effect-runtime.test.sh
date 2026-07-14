#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
NODE_BIN=${PI_ENV_TEST_NODE_BIN:-node}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

set +e
REPO= "$NODE_BIN" setup/configure.mjs pi >"$tmp/missing.out" 2>"$tmp/missing.err"
status=$?
set -e
if [ "$status" -ne 1 ] || [ "$(grep -c '^REPO is required$' "$tmp/missing.err")" -ne 1 ]; then
  echo "FAIL: setup env error should render exactly once" >&2
  cat "$tmp/missing.err" >&2
  exit 1
fi

export REPO="$ROOT"
export SETUP_DIR="$ROOT/setup"
export SETTINGS_FILE="$tmp/settings.json"
export MANAGED_SETTINGS_FILE="$ROOT/setup/config/managed-settings.json"
export AGENTS_DIR="$tmp/agents"
export TEST_UTILS_DIR="$tmp/test-utils"
export APPEND_SRC="$ROOT/AGENTS.md"
export APPEND_DST="$tmp/APPEND_SYSTEM.md"
export APPEND_MARKER="<!-- pi-env managed block -->"
export PI_AGENT_DIR="$tmp/pi-agent"
export TMUX_CONF="$tmp/tmux.conf"
export TMUX_SOURCE_LINE="source-file $ROOT/setup/templates/tmux.conf"
export GHOSTTY_CONFIG_DIR="$tmp/ghostty"
export POST_MERGE_HOOK_SRC="$ROOT/setup/hooks/post-merge"
export PRE_COMMIT_HOOK_SRC="$ROOT/setup/hooks/pre-commit"

set +e
"$NODE_BIN" setup/configure.mjs not-a-command >"$tmp/unknown.out" 2>"$tmp/unknown.err"
status=$?
set -e
if [ "$status" -ne 2 ] || [ "$(grep -c '^unknown configure command: not-a-command$' "$tmp/unknown.err")" -ne 1 ]; then
  echo "FAIL: usage error should preserve exit code and render exactly once" >&2
  cat "$tmp/unknown.err" >&2
  exit 1
fi

set +e
"$NODE_BIN" setup/configure.mjs pi "$tmp/no-such-node" >"$tmp/start.out" 2>"$tmp/start.err"
status=$?
set -e
if [ "$status" -ne 1 ] || [ "$(grep -c 'no-such-node setup/apply-managed-settings.mjs .* failed to start:' "$tmp/start.err")" -ne 1 ]; then
  echo "FAIL: command start errors should render exactly once" >&2
  cat "$tmp/start.err" >&2
  exit 1
fi

cat >"$tmp/node-fails" <<'SH'
#!/usr/bin/env bash
echo injected failure >&2
exit 7
SH
chmod +x "$tmp/node-fails"
set +e
"$NODE_BIN" setup/configure.mjs pi "$tmp/node-fails" >"$tmp/cmd.out" 2>"$tmp/cmd.err"
status=$?
set -e
if [ "$status" -ne 7 ] || [ "$(grep -c 'node-fails setup/apply-managed-settings.mjs .* exited with 7: injected failure' "$tmp/cmd.err")" -ne 1 ]; then
  echo "FAIL: command exit errors should render exactly once" >&2
  cat "$tmp/cmd.err" >&2
  exit 1
fi

printf 'not a directory' >"$tmp/blocked-tmux"
set +e
PI_ENV_SETUP_MODE=portable PI_ENV_CONFIG_MANAGED_BY_NIX=0 PI_ENV_SKIP_TERMINAL=0 PI_ENV_SKIP_GHOSTTY=1 TMUX_CONF="$tmp/blocked-tmux/config" "$NODE_BIN" setup/configure.mjs terminal >"$tmp/fs.out" 2>"$tmp/fs.err"
status=$?
set -e
if [ "$status" -ne 1 ] || [ "$(grep -c "configure tmux failed for $tmp/blocked-tmux/config:" "$tmp/fs.err")" -ne 1 ]; then
  echo "FAIL: filesystem errors should render exactly once" >&2
  cat "$tmp/fs.err" >&2
  exit 1
fi

printf 'not a directory' >"$tmp/blocked-ghostty"
PI_ENV_SETUP_MODE=portable PI_ENV_CONFIG_MANAGED_BY_NIX=0 PI_ENV_SKIP_TERMINAL=0 PI_ENV_SKIP_GHOSTTY=0 GHOSTTY_CONFIG_DIR="$tmp/blocked-ghostty" SHOULD_LINK_GHOSTTY=1 "$NODE_BIN" setup/configure.mjs terminal >"$tmp/ghostty.out" 2>"$tmp/ghostty.err"
if ! grep -q "~/.config/ghostty (cannot create $tmp/blocked-ghostty)" "$tmp/ghostty.out"; then
  echo "FAIL: unavailable optional Ghostty directory should remain a non-fatal skip" >&2
  cat "$tmp/ghostty.out" >&2
  cat "$tmp/ghostty.err" >&2
  exit 1
fi

cleanup_script="$ROOT/.effect-runtime-cleanup-$$.mjs"
trap 'rm -rf "$tmp" "$cleanup_script"' EXIT
cat >"$cleanup_script" <<'JS'
import { appendFileSync } from 'node:fs';
import { NodeRuntime } from '@effect/platform-node';
import { Effect } from 'effect';
const marker = process.argv[2];
const cleanupMarker = process.argv[3];
NodeRuntime.runMain(Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.sync(() => appendFileSync(cleanupMarker, `cleanup:${marker}\n`)));
  yield* Effect.callback((resume) => {
    const waitForSignalHandler = () => {
      if (process.listenerCount('SIGINT') > 0) {
        resume(Effect.void);
        return;
      }
      setImmediate(waitForSignalHandler);
    };
    setImmediate(waitForSignalHandler);
  });
  yield* Effect.sync(() => console.log(`ready:${marker}`));
  yield* Effect.never;
})));
JS
cleanup_marker="$tmp/cleanup.marker"
: >"$cleanup_marker"
"$NODE_BIN" "$cleanup_script" ok "$cleanup_marker" >"$tmp/cleanup.out" 2>"$tmp/cleanup.err" &
pid=$!
ready=0
for _ in $(seq 1 100); do
  if grep -q '^ready:ok$' "$tmp/cleanup.out"; then
    ready=1
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.05
done
if [ "$ready" -ne 1 ]; then
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "FAIL: NodeRuntime cleanup fixture did not become ready" >&2
  cat "$tmp/cleanup.out" >&2
  cat "$tmp/cleanup.err" >&2
  exit 1
fi
kill -INT "$pid"
exited=0
for _ in $(seq 1 100); do
  if ! kill -0 "$pid" 2>/dev/null; then
    exited=1
    break
  fi
  sleep 0.05
done
if [ "$exited" -ne 1 ]; then
  kill -TERM "$pid" 2>/dev/null || true
  sleep 0.1
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "FAIL: NodeRuntime did not exit after SIGINT" >&2
  cat "$tmp/cleanup.out" >&2
  cat "$tmp/cleanup.err" >&2
  exit 1
fi
wait "$pid" || true
if ! grep -q '^cleanup:ok$' "$cleanup_marker"; then
  echo "FAIL: NodeRuntime interruption should run scoped cleanup" >&2
  cat "$tmp/cleanup.out" >&2
  cat "$tmp/cleanup.err" >&2
  cat "$cleanup_marker" >&2
  exit 1
fi

if grep -R "from 'effect'\|from \"effect\"\|@effect/platform" setup.sh setup/main.sh setup/install.sh setup/runtime.mjs scripts/check-node-version.mjs >/dev/null; then
  echo "FAIL: preinstall/bootstrap boundary must remain Effect/platform-free" >&2
  exit 1
fi

echo "effect runtime tests passed"
