#!/usr/bin/env bash
# build-extensions.sh — Compile each extension to a single dist/index.js bundle.
#
# Run after any source change, or automatically via postinstall:
#   bun run build
#
# Each extension is bundled with Bun (--target bun, --format esm).
# Pi peer packages are marked external so the runtime copies provided by pi
# are used instead of bundled duplicates.
#
# The cross-extension singleton services (tmux-service, bus-service) use
# globalThis storage so their bundled copies across orch + tmux / orch + agent-bus
# all share the same live instance at runtime.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$REPO_ROOT/.pi/extensions"

# Pi peer packages — always external (pi provides these at runtime).
PEER_EXTERNALS=(
  "--external" "@mariozechner/pi-coding-agent"
  "--external" "@mariozechner/pi-ai"
  "--external" "@mariozechner/pi-tui"
  "--external" "@mariozechner/pi-agent-core"
  "--external" "@sinclair/typebox"
)

EXTENSIONS=(
  agent-bus
  dev-tools
  jit-catch
  orch
  ptc
  security
  skill-builder
  subagent
  tmux
  usage-bar
  work-tracker
)

ok=0
fail=0

for ext in "${EXTENSIONS[@]}"; do
  entry="$EXT_DIR/$ext/index.ts"
  outdir="$EXT_DIR/$ext/dist"

  if [ ! -f "$entry" ]; then
    echo "  skip  $ext (no index.ts)"
    continue
  fi

  mkdir -p "$outdir"
  if bun build "$entry" \
    --outfile "$outdir/index.js" \
    --target bun \
    --format esm \
    "${PEER_EXTERNALS[@]}" 2>&1; then
    # ptc: copy subprocess-preamble.ts into dist/ so that the bundled executor
    # (which resolves paths relative to import.meta.url = dist/index.js) can find it.
    if [ "$ext" = "ptc" ]; then
      cp "$EXT_DIR/ptc/subprocess-preamble.ts" "$outdir/subprocess-preamble.ts"
    fi
    echo "  built $ext"
    ok=$((ok + 1))
  else
    echo "  FAIL  $ext"
    fail=$((fail + 1))
  fi
done

echo ""
if [ "$fail" -eq 0 ]; then
  echo "All $ok extensions built successfully."
else
  echo "$ok built, $fail failed."
  exit 1
fi
