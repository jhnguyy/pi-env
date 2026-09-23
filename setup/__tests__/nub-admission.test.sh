#!/usr/bin/env bash
set -euo pipefail
# Public-entrypoint tests use controlled tools: a real install cannot safely or
# repeatably exercise obsolete/missing toolchains without network/global state.
# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
TEMP=$(with_temp_dir)
# Keep evidence (including failures) for inspection; no credentials are copied.
printf 'Reproduce: bash setup/__tests__/nub-admission.test.sh\nExpected: rejected tools only receive --version outside the repo; accepted tools reach Node resolution. Dependencies and HOME remain unchanged.\n' > "$TEMP/README"
mkdir -p "$TEMP/repo/node_modules" "$TEMP/bin" "$TEMP/home"
cp "$ROOT/setup.sh" "$TEMP/repo/"
cp -R "$ROOT/setup" "$TEMP/repo/"
cp "$ROOT/package.json" "$TEMP/repo/"
printf sentinel > "$TEMP/repo/node_modules/sentinel"
for tool in bash dirname uname; do ln -s "$(command -v "$tool")" "$TEMP/bin/$tool"; done
make_executable "$TEMP/bin/git" '#!/bin/bash
exit 0'
make_executable "$TEMP/bin/node" '#!/bin/bash
printf "node %s admitted=%s\n" "$*" "$PI_ENV_NUB_BIN" >> "$LOG"
case "$1" in */check-node-version.mjs) exit 0 ;; esac
exit 39'
make_executable "$TEMP/bin/nub" '#!/bin/bash
printf "nub %s cwd=%s\n" "$*" "$PWD" >> "$LOG"
case "$*" in
  --version) printf "%s\n" "$VERSION"; exit "${VERSION_STATUS:-0}" ;;
  "node which") printf "%s/node\n" "${0%/*}" ;;
  *) exit 41 ;;
esac'
PIN=$(sed -n 's/.*"packageManager": "nub@\([^"]*\)".*/\1/p' "$ROOT/package.json")
run_case() {
  local name="$1" mode="$2" version="$3" expected="$4" status=0
  local log="$TEMP/$name.log" output="$TEMP/$name.output"
  : > "$log"
  (cd "$TEMP/repo" && HOME="$TEMP/home" PATH="$TEMP/bin" LOG="$log" VERSION="$version" \
    PI_ENV_NODE_BIN= NODE_EXECUTABLE= PI_ENV_NUB_BIN=/untrusted/override \
    /bin/bash ./setup.sh "$mode") > "$output" 2>&1 || status=$?
  printf '%s: status=%s expected=%s\n' "$name" "$status" "$expected" >> "$TEMP/README"
  [ "$status" -ne 0 ] || fail "$name unexpectedly completed setup"
  if [ "$expected" = reject ]; then
    assert_file_contains "$output" 'package.json#packageManager'
    assert_file_contains "$output" 'docs/prerequisites.md'
    ! grep -q 'node ' "$log" || fail "$name executed Node or nub node before rejection"
    ! grep -q "cwd=$TEMP/repo" "$log" || fail "$name invoked Nub in repository"
    [ "$(wc -l < "$log")" -le 1 ] || fail "$name retried Nub"
  else
    assert_file_contains "$log" "nub node which cwd=$TEMP/repo"
    assert_file_contains "$log" "runtime.mjs"
    assert_file_contains "$log" "admitted=$TEMP/bin/nub"
    assert_eq "$status" 39 "admitted setup reaches runtime"
  fi
  assert_eq "$(cat "$TEMP/repo/node_modules/sentinel")" sentinel 'dependencies preserved'
  [ "$(find "$TEMP/repo/node_modules" -type f | wc -l)" -eq 1 ] || fail 'dependency mutation'
  [ -z "$(ls -A "$TEMP/home")" ] || fail 'HOME mutation'
}
run_case stale --portable 0.0.1 reject
run_case malformed --portable "${PIN} garbage" reject
run_case empty --portable '' reject
run_case multiline --portable "v$PIN"$'\nextra' reject
run_case newer --portable 999.0.0 reject
VERSION_STATUS=1 run_case failed-probe --portable "$PIN" reject
run_case nix-stale --nix-managed 0.0.1 reject
mv "$TEMP/bin/nub" "$TEMP/nub"
run_case missing --portable '' reject
mv "$TEMP/nub" "$TEMP/bin/nub"
run_case admitted --portable "v$PIN" accept
run_case nix-admitted --nix-managed "v$PIN" accept
make_executable "$TEMP/bin/nix" '#!/bin/bash
printf "nix %s\n" "$*" >> "$LOG"
exit 57'
: > "$TEMP/auto-nix.log"
auto_status=0
(cd "$TEMP/repo" && HOME="$TEMP/home" PATH="$TEMP/bin" LOG="$TEMP/auto-nix.log" \
  PI_ENV_SETUP_MODE= PI_ENV_CONFIG_MANAGED_BY_NIX=0 PI_ENV_AUTO_NIX=1 \
  /bin/bash ./setup.sh) > "$TEMP/auto-nix.output" 2>&1 || auto_status=$?
assert_eq "$auto_status" 57 'automatic Nix failure propagates without portable retry'
assert_file_contains "$TEMP/auto-nix.log" 'nix run .#setup --'
[ "$(wc -l < "$TEMP/auto-nix.log")" -eq 1 ] || fail 'automatic Nix failure retried'
assert_eq "$(cat "$TEMP/repo/node_modules/sentinel")" sentinel 'automatic Nix failure preserved dependencies'
echo "Nub admission tests passed; evidence: $TEMP"
