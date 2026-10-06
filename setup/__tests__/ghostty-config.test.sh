#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NODE=${PI_ENV_TEST_NODE_BIN:-node}
GHOSTTY=${PI_ENV_TEST_GHOSTTY_BIN:-$(command -v ghostty || true)}
if [ -z "$GHOSTTY" ] && [ -x /Applications/Ghostty.app/Contents/MacOS/ghostty ]; then
  GHOSTTY=/Applications/Ghostty.app/Contents/MacOS/ghostty
fi
EVIDENCE=$(mktemp -d "${PI_ENV_SETUP_EVIDENCE_DIR:-${TMPDIR:-/tmp}}/pi-env-ghostty-XXXXXX")
printf 'Ghostty workflow evidence: %s\n' "$EVIDENCE"
exec 3>&1
exec >>"$EVIDENCE/workflow.log" 2>&1
finish() {
  local status=$?
  EVIDENCE="$EVIDENCE" STATUS="$status" GHOSTTY="$GHOSTTY" "$NODE" --input-type=module <<'JS'
import fs from 'node:fs';
const {EVIDENCE, STATUS, GHOSTTY} = process.env;
fs.writeFileSync(`${EVIDENCE}/result.json`, JSON.stringify({
  expected: 'both config layouts load XDG Gruvbox themes and adjacent local overrides; setup reruns preserve links',
  actual: {exitStatus: Number(STATUS), ghostty: GHOSTTY || 'not installed; link checks only'},
  verdict: STATUS === '0' ? 'pass' : 'fail',
  reproduce: 'bash setup/__tests__/ghostty-config.test.sh',
  inspect: 'workflow.log, */validation.txt, */*-colors.txt, and */xdg/ghostty/themes',
}, null, 2) + '\n');
JS
  printf 'Ghostty workflow exit: %s\n' "$status" >&3
  exit "$status"
}
trap finish EXIT

export PI_ENV_SETUP_MODE=portable PI_ENV_CONFIG_MANAGED_BY_NIX=0
export PI_ENV_SKIP_TERMINAL=0 PI_ENV_SKIP_GHOSTTY=0 SHOULD_LINK_GHOSTTY=1
unset PI_AGENT_DIR PI_CODING_AGENT_DIR
for layout in macos xdg; do
  export HOME="$EVIDENCE/$layout/home"
  mkdir -p "$HOME"
  export XDG_CONFIG_HOME="$EVIDENCE/$layout/xdg"
  if [ "$layout" = macos ]; then
    export GHOSTTY_CONFIG_DIR="$HOME/Library/Application Support/com.mitchellh.ghostty"
  else
    export GHOSTTY_CONFIG_DIR="$XDG_CONFIG_HOME/ghostty"
  fi
  source "$ROOT/setup/context.sh"
  setup_init_context "$ROOT/setup"
  export REPO SETUP_DIR SETTINGS_FILE AGENTS_DIR TEST_UTILS_DIR APPEND_SRC APPEND_DST APPEND_MARKER PI_AGENT_DIR TMUX_CONF TMUX_SOURCE_LINE GHOSTTY_CONFIG_DIR POST_MERGE_HOOK_SRC PRE_COMMIT_HOOK_SRC
  for run in first rerun; do
    printf 'Setup run: %s\n' "$run"
    "$NODE" "$ROOT/setup/configure.mjs" terminal
    [ "$(readlink "$GHOSTTY_CONFIG_DIR/config")" = "$ROOT/ghostty/config" ]
    for mode in dark light; do
      [ "$(readlink "$XDG_CONFIG_HOME/ghostty/themes/pi-env-gruvbox-$mode")" = "$ROOT/ghostty/themes/pi-env-gruvbox-$mode" ]
    done
  done
  printf 'font-size = 19\n' >"$GHOSTTY_CONFIG_DIR/config.local"
  if [ -n "$GHOSTTY" ]; then
    "$GHOSTTY" +validate-config --config-file="$GHOSTTY_CONFIG_DIR/config" >"$EVIDENCE/$layout/validation.txt" 2>&1
    [ ! -s "$EVIDENCE/$layout/validation.txt" ]
    if [ "$layout" = macos ]; then
      ln -s "$GHOSTTY_CONFIG_DIR/config" "$XDG_CONFIG_HOME/ghostty/config"
      ln -s "$GHOSTTY_CONFIG_DIR/config.local" "$XDG_CONFIG_HOME/ghostty/config.local"
    fi
    for mode in dark light; do
      printf 'font-size = 19\ntheme = pi-env-gruvbox-%s\n' "$mode" >"$GHOSTTY_CONFIG_DIR/config.local"
      "$GHOSTTY" +show-config >"$EVIDENCE/$layout/$mode-colors.txt" 2>&1
      grep -Fxq 'font-size = 19' "$EVIDENCE/$layout/$mode-colors.txt"
      if [ "$mode" = dark ]; then
        grep -Fxq 'background = #282828' "$EVIDENCE/$layout/$mode-colors.txt"
        grep -Fxq 'foreground = #ebdbb2' "$EVIDENCE/$layout/$mode-colors.txt"
      else
        grep -Fxq 'background = #fbf1c7' "$EVIDENCE/$layout/$mode-colors.txt"
        grep -Fxq 'foreground = #3c3836' "$EVIDENCE/$layout/$mode-colors.txt"
      fi
    done
  fi
  unset PI_AGENT_DIR PI_CODING_AGENT_DIR
done
