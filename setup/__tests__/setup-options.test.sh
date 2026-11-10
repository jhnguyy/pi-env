#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

# A stub nix reports its argv on stdout, which exec passes through setup.sh.
test_nix_entrypoints_delegate_without_portable_fallback() {
  local tmp status=0
  tmp="$(with_temp_dir)"
  make_executable "$tmp/nix" '#!/bin/sh
printf "%s\n" "$*"'
  run_setup() {
    env -u PI_ENV_SETUP_MODE -u PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_AUTO_NIX=1 \
      HOME="$tmp/home" PI_AGENT_DIR="$tmp/agent" PI_CODING_AGENT_DIR="$tmp/agent" \
      PATH="$tmp:$PATH" "$ROOT/setup.sh" "$@"
  }

  assert_eq "$(run_setup --no-terminal)" "run .#setup -- --no-terminal" "plain ./setup.sh should auto-run nix setup"
  assert_eq "$(run_setup --use-nix --no-terminal)" "run .#setup -- --no-terminal" "--use-nix should re-exec nix setup"
  assert_eq "$(run_setup --reset --use-nix --no-terminal)" "run .#setup -- --reset --no-terminal" 'mode can follow another option'
  assert_eq "$(run_setup --no-terminal --use-nix --use-nix)" "run .#setup -- --no-terminal" 'repeated same mode is harmless'

  local first second
  for first in --use-nix --portable --nix-managed; do
    for second in --use-nix --portable --nix-managed; do
      [ "$first" != "$second" ] || continue
      status=0
      run_setup "$first" --reset "$second" >"$tmp/stdout" 2>"$tmp/stderr" || status=$?
      assert_eq "$status" 2 'conflicting explicit modes fail'
      assert_file_contains "$tmp/stderr" 'Conflicting setup modes:'
      [ ! -s "$tmp/stdout" ] || fail 'conflicting modes must not invoke Nix'
    done
  done
  status=0
  run_setup --no-such-option >"$tmp/stdout" 2>"$tmp/stderr" || status=$?
  assert_eq "$status" 2 'invalid options fail before auto-Nix'
  [ ! -s "$tmp/stdout" ] || fail 'invalid option invoked Nix'
  assert_file_contains <(run_setup --use-nix --help) 'Usage: ./setup.sh'
  status=0

  make_executable "$tmp/nix" '#!/bin/sh
exit 37'
  run_setup --reset >/dev/null 2>&1 || status=$?
  assert_eq "$status" 37 'Nix failure remains visible'
  [ ! -e "$tmp/agent/settings.json" ] || fail 'Nix failure must not fall back to portable setup'
}

test_nix_app_validates_before_profile_effects() {
  local tmp status arg help_output
  tmp="$(with_temp_dir)"
  mkdir -p "$tmp/bin" "$tmp/home" "$tmp/checkout/setup"
  cp "$ROOT/setup/options.sh" "$tmp/checkout/setup/options.sh"
  printf '{}\n' > "$tmp/checkout/package.json"
  make_executable "$tmp/checkout/setup.sh" '#!/bin/sh
printf "setup: %s\n" "$*"'
  make_executable "$tmp/bin/nix-env" '#!/bin/sh
echo profile-installed >&2'
  run_nix_app() {
    (cd "$tmp/checkout" && env -u PI_ENV_SETUP_MODE \
      HOME="$tmp/home" PI_AGENT_DIR="$tmp/agent" PI_CODING_AGENT_DIR="$tmp/agent" \
      PI_ENV_AGENT_DIR_SCRIPT="$ROOT/setup/agent-dir.sh" PI_ENV_TOOLCHAIN=/stub/toolchain \
      PATH="$tmp/bin:$PATH" bash "$ROOT/nix/setup.sh" "$@")
  }
  help_output=$(run_nix_app --no-terminal --help 2>"$tmp/stderr")
  [ ! -s "$tmp/stderr" ] || fail 'help installed a profile'
  grep -qF 'Usage: ./setup.sh' <<<"$help_output" || fail 'Nix app did not show help'
  for arg in --invalid --portable; do
    status=0
    run_nix_app --nix-managed "$arg" >"$tmp/stdout" 2>"$tmp/stderr" || status=$?
    assert_eq "$status" 2 'Nix app rejects invalid/conflicting arguments'
    if grep -qF profile-installed "$tmp/stderr"; then
      fail 'argument validation ran after profile installation'
    fi
  done
  status=0
  run_nix_app --help --invalid >"$tmp/stdout" 2>"$tmp/stderr" || status=$?
  assert_eq "$status" 2 'help does not hide invalid options'
  [ ! -e "$tmp/home/.local/state/pi-env" ] || fail 'argument validation created profile state'
  assert_eq "$(run_nix_app --no-terminal --nix-managed 2>"$tmp/stderr")" \
    'setup: --no-terminal --nix-managed' 'validated Nix app forwards original arguments'
  assert_file_contains "$tmp/stderr" 'profile-installed'
}

test_nix_entrypoints_delegate_without_portable_fallback
test_nix_app_validates_before_profile_effects

echo "setup option tests passed"
