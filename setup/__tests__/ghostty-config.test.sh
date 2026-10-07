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

INSTALL=fail
LOADING=skipped
DISCOVERY=skipped
if [ -z "$GHOSTTY" ]; then
  LOADING_NOTE='Ghostty not installed'
  DISCOVERY_NOTE='Ghostty not installed'
else
  LOADING_NOTE="$GHOSTTY"
  # Ghostty resolves Application Support outside $HOME, so default discovery is only isolated off macOS.
  DISCOVERY_NOTE=$([ "$(uname -s)" = Darwin ] && echo 'macOS discovery reads the real user config; not isolatable' || echo "$GHOSTTY")
fi
finish() {
  local status=$?
  EVIDENCE="$EVIDENCE" STATUS="$status" INSTALL="$INSTALL" LOADING="$LOADING" DISCOVERY="$DISCOVERY" \
    LOADING_NOTE="$LOADING_NOTE" DISCOVERY_NOTE="$DISCOVERY_NOTE" "$NODE" --input-type=module <<'JS'
import fs from 'node:fs';
const e = process.env;
const checks = {
  installation: {expected: 'setup links config and both palettes into the XDG theme directory; reruns preserve links', verdict: e.INSTALL},
  explicitLoading: {expected: 'Ghostty loads each installed config by path, resolves both palettes from XDG, and loads ~/.config/ghostty/config.local through the symlinked config', verdict: e.LOADING, note: e.LOADING_NOTE},
  xdgDiscovery: {expected: 'Ghostty default discovery reports Gruvbox colors and local override values', verdict: e.DISCOVERY, note: e.DISCOVERY_NOTE},
};
const verdicts = Object.values(checks).map((check) => check.verdict);
fs.writeFileSync(`${e.EVIDENCE}/result.json`, JSON.stringify({
  checks,
  exitStatus: Number(e.STATUS),
  verdict: e.STATUS !== '0' || verdicts.includes('fail') ? 'fail' : verdicts.includes('skipped') ? 'partial' : 'pass',
  reproduce: 'bash setup/__tests__/ghostty-config.test.sh',
  inspect: 'workflow.log and */*.txt',
}, null, 2) + '\n');
JS
  printf 'Ghostty workflow exit: %s (installation=%s explicitLoading=%s xdgDiscovery=%s)\n' "$status" "$INSTALL" "$LOADING" "$DISCOVERY" >&3
  exit "$status"
}
trap finish EXIT

LOCAL_OVERRIDE_REL=.config/ghostty/config.local
validate() {
  "$GHOSTTY" +validate-config --config-file="$GHOSTTY_CONFIG_DIR/config" >"$EVIDENCE/$layout/$1.txt" 2>&1
}

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
    printf 'Setup run: %s/%s\n' "$layout" "$run"
    "$NODE" "$ROOT/setup/configure.mjs" terminal
    [ "$(readlink "$GHOSTTY_CONFIG_DIR/config")" = "$ROOT/ghostty/config" ]
    for mode in dark light; do
      [ "$(readlink "$XDG_CONFIG_HOME/ghostty/themes/pi-env-gruvbox-$mode")" = "$ROOT/ghostty/themes/pi-env-gruvbox-$mode" ]
    done
  done
  unset PI_AGENT_DIR PI_CODING_AGENT_DIR
done
INSTALL=pass

[ -n "$GHOSTTY" ] || exit 0
LOADING=fail
for layout in macos xdg; do
  export HOME="$EVIDENCE/$layout/home" XDG_CONFIG_HOME="$EVIDENCE/$layout/xdg"
  if [ "$layout" = macos ]; then
    export GHOSTTY_CONFIG_DIR="$HOME/Library/Application Support/com.mitchellh.ghostty"
  else
    export GHOSTTY_CONFIG_DIR="$XDG_CONFIG_HOME/ghostty"
  fi
  LOCAL_OVERRIDE="$HOME/$LOCAL_OVERRIDE_REL"
  mkdir -p "$(dirname "$LOCAL_OVERRIDE")"
  validate default
  [ ! -s "$EVIDENCE/$layout/default.txt" ]
  for mode in dark light; do
    printf 'theme = pi-env-gruvbox-%s\n' "$mode" >"$LOCAL_OVERRIDE"
    validate "$mode"
    [ ! -s "$EVIDENCE/$layout/$mode.txt" ]
  done
  # Negative controls prove that validation reads config.local and searches the XDG theme directory.
  printf 'theme = pi-env-missing-theme\n' >"$LOCAL_OVERRIDE"
  if validate missing-theme-control; then exit 1; fi
  grep -Fq "$XDG_CONFIG_HOME/ghostty/themes/pi-env-missing-theme" "$EVIDENCE/$layout/missing-theme-control.txt"
  printf 'font-size = invalid\n' >"$LOCAL_OVERRIDE"
  if validate local-override-control; then exit 1; fi
  grep -Fq 'font-size: invalid value "invalid"' "$EVIDENCE/$layout/local-override-control.txt"
  rm "$LOCAL_OVERRIDE"
done
LOADING=pass

[ "$(uname -s)" != Darwin ] || exit 0
DISCOVERY=fail
export HOME="$EVIDENCE/xdg/home" XDG_CONFIG_HOME="$EVIDENCE/xdg/xdg" GHOSTTY_CONFIG_DIR="$EVIDENCE/xdg/xdg/ghostty"
LOCAL_OVERRIDE="$HOME/$LOCAL_OVERRIDE_REL"
for mode in dark light; do
  printf 'font-size = 19\ntheme = pi-env-gruvbox-%s\n' "$mode" >"$LOCAL_OVERRIDE"
  "$GHOSTTY" +show-config >"$EVIDENCE/xdg/$mode-colors.txt" 2>&1
  grep -Fxq 'font-size = 19' "$EVIDENCE/xdg/$mode-colors.txt"
  if [ "$mode" = dark ]; then
    grep -Fxq 'background = #282828' "$EVIDENCE/xdg/$mode-colors.txt"
    grep -Fxq 'foreground = #ebdbb2' "$EVIDENCE/xdg/$mode-colors.txt"
  else
    grep -Fxq 'background = #fbf1c7' "$EVIDENCE/xdg/$mode-colors.txt"
    grep -Fxq 'foreground = #3c3836' "$EVIDENCE/xdg/$mode-colors.txt"
  fi
done
DISCOVERY=pass
