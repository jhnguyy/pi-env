#!/usr/bin/env bash
set -euo pipefail
# A real obsolete Nub can change dependencies before setup rejects it. Exercise
# the public entrypoint with a controlled PATH instead.
# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
TEMP=$(with_temp_dir)
mkdir -p "$TEMP/repo/node_modules" "$TEMP/bin" "$TEMP/home"
cp "$ROOT/setup.sh" "$TEMP/repo/"
cp -R "$ROOT/setup" "$TEMP/repo/"
cp "$ROOT/package.json" "$TEMP/repo/"
printf sentinel > "$TEMP/repo/node_modules/sentinel"
for tool in bash dirname uname; do ln -s "$(command -v "$tool")" "$TEMP/bin/$tool"; done
make_executable "$TEMP/bin/nub" '#!/bin/bash
printf "nub %s cwd=%s\n" "$*" "$PWD" >> "$LOG"
if [ "$*" = --version ]; then printf "v0.2.10\n"; exit 0; fi
exit 41'

cat > "$TEMP/README" <<'EOF'
Reproduce: bash setup/__tests__/nub-admission.test.sh
Expected: stale Nub is rejected before any repository-context Nub call;
failed automatic Nix setup does not retry through portable setup.
Actual: see stale.output, stale.log, auto-nix.output, and auto-nix.log.
The dependency sentinel and temporary HOME must remain unchanged.
EOF

: > "$TEMP/stale.log"
stale_status=0
(cd "$TEMP/repo" && HOME="$TEMP/home" PATH="$TEMP/bin" LOG="$TEMP/stale.log" \
  PI_ENV_NODE_BIN= NODE_EXECUTABLE= PI_ENV_CONFIG_MANAGED_BY_NIX=0 \
  /bin/bash ./setup.sh --portable) > "$TEMP/stale.output" 2>&1 || stale_status=$?
[ "$stale_status" -ne 0 ] || fail 'setup accepted stale Nub'
assert_file_contains "$TEMP/stale.output" 'package.json#packageManager'
assert_file_contains "$TEMP/stale.output" 'docs/prerequisites.md'
[ "$(wc -l < "$TEMP/stale.log")" -eq 1 ] || fail 'stale Nub reached another command'
! grep -q "cwd=$TEMP/repo" "$TEMP/stale.log" || fail 'stale Nub ran in repository'
assert_eq "$(cat "$TEMP/repo/node_modules/sentinel")" sentinel 'dependencies preserved after rejection'
[ -z "$(ls -A "$TEMP/home")" ] || fail 'HOME changed after rejection'

make_executable "$TEMP/bin/nix" '#!/bin/bash
printf "nix %s\n" "$*" >> "$LOG"
exit 57'
: > "$TEMP/auto-nix.log"
auto_status=0
(cd "$TEMP/repo" && HOME="$TEMP/home" PATH="$TEMP/bin" LOG="$TEMP/auto-nix.log" \
  PI_ENV_SETUP_MODE= PI_ENV_CONFIG_MANAGED_BY_NIX=0 PI_ENV_AUTO_NIX=1 \
  /bin/bash ./setup.sh) > "$TEMP/auto-nix.output" 2>&1 || auto_status=$?
assert_eq "$auto_status" 57 'automatic Nix failure must not retry with portable tools'
assert_file_contains "$TEMP/auto-nix.log" 'nix run .#setup --'
[ "$(wc -l < "$TEMP/auto-nix.log")" -eq 1 ] || fail 'automatic Nix failure retried'
assert_eq "$(cat "$TEMP/repo/node_modules/sentinel")" sentinel 'dependencies preserved after Nix failure'
[ -z "$(ls -A "$TEMP/home")" ] || fail 'HOME changed after Nix failure'
printf 'stale exit=%s; automatic Nix exit=%s\n' "$stale_status" "$auto_status" >> "$TEMP/README"
echo "Nub admission tests passed; evidence: $TEMP"
