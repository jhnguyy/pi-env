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
# The cross-extension singleton services use
# globalThis storage so their bundled copies share the same live instance at runtime.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$REPO_ROOT/.pi/extensions"

# Pi peer packages — always external (pi provides these at runtime).
PEER_EXTERNALS=(
  "--external" "@mariozechner/pi-coding-agent"
  "--external" "@mariozechner/pi-ai"
  "--external" "@mariozechner/pi-tui"
  "--external" "@mariozechner/pi-agent-core"
  "--external" "typebox"
  "--external" "@sinclair/typebox"
)

EXTENSIONS=(
  dev-tools
  jit-catch
  ptc
  security
  skill-builder
  subagent
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
    # Some extensions reference additional files at runtime via import.meta.url-
    # relative paths. Since import.meta.url points to dist/index.js after bundling,
    # those files must exist inside dist/. We bundle each as a standalone ESM file
    # (so local imports get inlined) rather than a plain copy (which would leave
    # relative imports broken).
    #
    # ptc: subprocess-preamble.ts is loaded by the generated subprocess script.
    #   Imports MAX_TOOL_CALLS from ./types — bundle to inline it.
    if [ "$ext" = "ptc" ]; then
      bun build "$EXT_DIR/ptc/subprocess-preamble.ts" \
        --outfile "$outdir/subprocess-preamble.ts" \
        --target bun \
        --format esm 2>&1
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
