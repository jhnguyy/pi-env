#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"

run_admission() {
  local package_json=$1 output=$2 exit_status=$3
  local temp repo bin status
  temp=$(with_temp_dir)
  repo="$temp/repo"
  bin="$temp/nub"
  mkdir -p "$repo"
  printf '%s\n' "$package_json" > "$repo/package.json"
  make_executable "$bin" '#!/usr/bin/env bash
printf "%b" "${NUB_OUTPUT:-}"
exit "${NUB_EXIT_STATUS:-0}"'

  set +e
  NUB_BIN="$bin" NUB_OUTPUT="$output" NUB_EXIT_STATUS="$exit_status" \
    "$(node_bin)" "$ROOT/scripts/check-nub-version.mjs" "$repo" >/dev/null 2>&1
  status=$?
  set -e
  rm -rf "$temp"
  return "$status"
}

assert_admitted() {
  run_admission "$@" || fail "Nub version admission rejected valid input"
}

assert_rejected() {
  if run_admission "$@"; then
    fail "Nub version admission accepted invalid input"
  fi
}

assert_admitted '{"packageManager":"nub@1.2.3"}' 'v1.2.3\n' 0
assert_rejected '{"metadata":{"packageManager":"nub@1.2.3"}}' '1.2.3\n' 0
assert_rejected '{"packageManager":"nub@1.2.3","packageManager":"npm@1.2.3"}' '1.2.3\n' 0
assert_rejected '{}' '1.2.3\n' 0
assert_rejected '{"packageManager":123}' '1.2.3\n' 0
assert_rejected '{"packageManager":"npm@1.2.3"}' '1.2.3\n' 0
assert_rejected '{"packageManager":"nub@latest"}' '1.2.3\n' 0
assert_rejected '{"packageManager":"nub@^1.2.3"}' '1.2.3\n' 0
assert_rejected '{"packageManager":" nub@1.2.3"}' '1.2.3\n' 0
assert_rejected '{"packageManager":"nub@1.2.3"}' 'not-a-version\n' 0
assert_rejected '{"packageManager":"nub@1.2.3"}' '' 0
assert_rejected '{"packageManager":"nub@1.2.3"}' '1.2.3\nextra\n' 0
assert_rejected '{"packageManager":"nub@1.2.3"}' '1.2.3\n' 9
assert_rejected '{"packageManager":"nub@1.2.3"}' '1.2.4\n' 0

echo "Nub version admission tests passed"
