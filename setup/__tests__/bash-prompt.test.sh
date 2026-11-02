#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

if [[ ${1:-} == child ]]; then
  cd "$HOME"
  PS1='original prompt> '
  if [[ ${4:-} == missing ]]; then unset TERM; fi
  case $2 in
    scalar) PROMPT_COMMAND=': scalar hook' ;;
    array) PROMPT_COMMAND=(': first hook' ': second hook') ;;
    unset) unset PROMPT_COMMAND ;;
  esac
  hook_before=$(declare -p PROMPT_COMMAND 2>/dev/null || :)
  term_before=$(declare -p TERM 2>/dev/null || :)
  exports_before=$(export -p)
  options_before=$(set +o; shopt -p || :)
  # Sourcing and rendering must work without any external commands on PATH.
  PATH=/no-prompt-commands
  source "$ROOT/setup/templates/bash-prompt.sh"
  assert_eq "$(declare -p PROMPT_COMMAND 2>/dev/null || :)" "$hook_before" 'prompt hooks preserved'
  assert_eq "$(declare -p TERM 2>/dev/null || :)" "$term_before" 'TERM preserved'
  assert_eq "$(set +o; shopt -p || :)" "$options_before" 'shell options preserved'
  # PATH was deliberately changed by this test, not by the fragment.
  PATH=$TEST_PATH
  assert_eq "$(export -p)" "$exports_before" 'exported environment preserved'

  if [[ $3 == guarded ]]; then
    assert_eq "$PS1" 'original prompt> ' 'guard preserves PS1'
    exit 0
  fi

  identity='\u@\h'
  identity=${identity@P}
  marker='\$'
  marker=${marker@P}
  for directory in "$HOME" "$HOME/work space"; do
    cd "$directory"
    rendered=${PS1@P}
    # Bash marks bracketed nonprinting spans with SOH/STX during prompt expansion.
    plain=${rendered//$'\001'/}
    plain=${plain//$'\002'/}
    visible_dir="~${directory#"$HOME"}"
    expected=$'\e[0;39m[\e[32m'"$identity"$'\e[0;39m:\e[1m'"$visible_dir"$'\e[0;39m]'"$marker"' '
    assert_eq "$plain" "$expected" 'expanded prompt explicitly resets brackets, colon, and marker to default foreground and nonbold, with green identity and bold default directory'
    printing=$rendered
    nonprinting_span=$'\001(\e\\[[0-9;]*m)+\002'
    while [[ $printing =~ $nonprinting_span ]]; do
      printing=${printing/"${BASH_REMATCH[0]}"/}
    done
    [[ $printing != *$'\e'* && $printing != *$'\001'* && $printing != *$'\002'* ]] ||
      fail 'ANSI sequences must be bracketed as nonprinting spans'
    assert_eq "$printing" "[$identity:$visible_dir]$marker " 'visible bracketed prompt follows cwd with no space before marker'
  done
  # Explicit opt-in remains stable when sourced again.
  before=$PS1
  source "$ROOT/setup/templates/bash-prompt.sh"
  assert_eq "$PS1" "$before" 'repeat sourcing preserves prompt behavior'
  exit 0
fi

fixture=$(with_temp_dir)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/work space"
for hooks in scalar array unset; do
  env -i HOME="$fixture" PATH="$PATH" TEST_PATH="$PATH" TERM=xterm-256color \
    "$BASH" --noprofile --norc -ic 'source "$1" child "$2" enabled' _ "$0" "$hooks"
done
for term in missing empty dumb; do
  term_env=()
  case $term in
    empty) term_env=(TERM=) ;;
    dumb) term_env=(TERM=dumb) ;;
  esac
  env -i HOME="$fixture" PATH="$PATH" TEST_PATH="$PATH" "${term_env[@]}" \
    "$BASH" --noprofile --norc -ic 'source "$1" child array guarded "$2"' _ "$0" "$term"
done
env -i HOME="$fixture" PATH="$PATH" TEST_PATH="$PATH" TERM=xterm-256color \
  "$BASH" --noprofile --norc -c 'source "$1" child scalar guarded' _ "$0"
printf 'PASS: Bash prompt rendering, hooks, environment, and guards\n'
