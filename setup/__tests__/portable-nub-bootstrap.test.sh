#!/usr/bin/env bash
set -euo pipefail
# Public entrypoint: failure must not run an unverified binary or touch deps.
# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
TEMP=$(with_temp_dir)
mkdir -p "$TEMP/repo/node_modules" "$TEMP/bin" "$TEMP/home"
cp "$ROOT/setup.sh" "$TEMP/repo/"
cp -R "$ROOT/setup" "$TEMP/repo/"
cp "$ROOT/package.json" "$TEMP/repo/"
printf sentinel > "$TEMP/repo/node_modules/sentinel"
for tool in bash dirname uname mktemp mkdir rm tar head; do ln -s "$(command -v "$tool")" "$TEMP/bin/$tool"; done
make_executable "$TEMP/bin/nub" '#!/bin/bash
printf "nub %s\n" "$*" >> "$LOG"
if [ "$*" = --version ]; then echo v0.2.10; exit 0; fi
exit 44'
make_executable "$TEMP/bin/curl" '#!/bin/bash
printf "curl %s\n" "$*" >> "$LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf "unverified" > "$1"; break; fi
  shift
done'
ln -s "$(command -v sha256sum)" "$TEMP/bin/sha256sum"
: > "$TEMP/log"
status=0
(cd "$TEMP/repo" && HOME="$TEMP/home" PATH="$TEMP/bin" LOG="$TEMP/log" \
  PI_ENV_CONFIG_MANAGED_BY_NIX=0 /bin/bash ./setup.sh --portable --bootstrap-nub) > "$TEMP/output" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail 'unverified Nub archive was accepted'
assert_file_contains "$TEMP/output" 'checksum mismatch'
! grep -q 'nub install' "$TEMP/log" || fail 'obsolete Nub installed dependencies'
assert_eq "$(cat "$TEMP/repo/node_modules/sentinel")" sentinel 'dependencies intact'
[ -z "$(ls -A "$TEMP/home")" ] || fail 'HOME was changed'
# Managed machines cannot bootstrap, even when --portable was requested.
: > "$TEMP/managed.log"
status=0
(cd "$TEMP/repo" && HOME="$TEMP/home" PATH="$TEMP/bin" LOG="$TEMP/managed.log" \
  PI_ENV_CONFIG_MANAGED_BY_NIX=1 /bin/bash ./setup.sh --portable --bootstrap-nub) > "$TEMP/managed.output" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail 'managed bootstrap was allowed'
assert_file_contains "$TEMP/managed.output" 'unavailable in a Nix-managed environment'
[ ! -s "$TEMP/managed.log" ] || fail 'managed bootstrap invoked Nub or curl'
status=0
(cd "$TEMP/repo" && HOME="$TEMP/home" PATH="$TEMP/bin" LOG="$TEMP/managed.log" \
  PI_ENV_CONFIG_MANAGED_BY_NIX=0 /bin/bash ./setup.sh --bootstrap-nub) > "$TEMP/mode.output" 2>&1 || status=$?
assert_eq "$status" 2 'bootstrap requires explicit portable mode'
assert_file_contains "$TEMP/mode.output" 'requires --portable'
[ ! -s "$TEMP/managed.log" ] || fail 'missing portable mode invoked Nub or curl'
make_executable "$TEMP/bin/nub" '#!/bin/bash
printf "nub %s\n" "$*" >> "$LOG"
if [ "$*" = --version ]; then echo v0.9.5; exit 0; fi
exit 44'
: > "$TEMP/matching.log"
(cd "$TEMP/repo" && HOME="$TEMP/home" PATH="$TEMP/bin" LOG="$TEMP/matching.log" \
  PI_ENV_CONFIG_MANAGED_BY_NIX=0 /bin/bash ./setup.sh --portable --bootstrap-nub) > "$TEMP/matching.output" 2>&1 || true
! grep -q curl "$TEMP/matching.log" || fail 'matching Nub was downloaded again'
assert_eq "$(cat "$TEMP/repo/node_modules/sentinel")" sentinel 'dependencies intact with matching Nub'
cat > "$TEMP/README" <<EOF
Reproduce: bash setup/__tests__/portable-nub-bootstrap.test.sh
Expected: wrong checksum or managed environment stops before Nub install and preserves dependencies and HOME.
Actual: checksum and managed exits were nonzero; missing-mode exit was $status. Inspect output, managed.output, mode.output, matching.output, log, managed.log, matching.log.
EOF
echo "Portable Nub bootstrap rejection passed; evidence: $TEMP"
