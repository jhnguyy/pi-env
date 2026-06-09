#!/usr/bin/env bash
# Tool/domain-oriented setup orchestration.

setup_bootstrap_file() {
  local src="$1" dst="$2" exists_label="$3" created_label="$4"
  if [ -e "$dst" ]; then
    ok "$exists_label"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    ok "$created_label"
  fi
}

setup_bootstrap_settings() {
  setup_bootstrap_file \
    "$SETUP_DIR/settings.template.json" \
    "$SETTINGS_FILE" \
    "settings.json (exists — not overwritten)" \
    "settings.json ← settings.template.json (review and customize: defaultModel, permissionLevel)"
}

setup_apply_managed_settings() {
  local result
  result=$(node "$SETUP_DIR/apply-managed-settings.mjs" "$SETTINGS_FILE" "$MANAGED_SETTINGS_FILE" "$REPO")
  case "$result" in
    unchanged) ok "managed settings and package registration" ;;
    created) linked "settings.json created with managed settings and package registration" ;;
    updated) linked "managed settings applied to settings.json" ;;
    *) echo "$result" ;;
  esac
}

setup_configure_pi() {
  section "Pi"

  setup_bootstrap_settings
  setup_apply_managed_settings

  mkdir -p "$AGENTS_DIR" "$TEST_UTILS_DIR"
  link_entries \
    "$REPO/.agents/roles|$AGENTS_DIR/roles|~/.agents/roles" \
    "$REPO/.pi/extensions/__tests__/test-utils.ts|$TEST_UTILS_DIR/test-utils.ts|~/.pi/agent/extensions/__tests__/test-utils.ts" \
    "$REPO/.pi/extensions/__tests__/loader.test.ts|$TEST_UTILS_DIR/loader.test.ts|~/.pi/agent/extensions/__tests__/loader.test.ts"

  append_once "$APPEND_SRC" "$APPEND_DST" "$APPEND_MARKER" "~/.pi/agent/APPEND_SYSTEM.md"

  setup_bootstrap_file \
    "$REPO/AGENTS.md" \
    "$PI_AGENT_DIR/AGENTS.md" \
    "~/.pi/agent/AGENTS.md (exists — not overwritten)" \
    "~/.pi/agent/AGENTS.md (bootstrapped from repo — customize for your environment)"
}

setup_configure_tmux() {
  if [ "${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}" = "1" ] || [ "${PI_ENV_SKIP_TMUX:-0}" = "1" ]; then
    skip "tmux config (managed externally)"
    return
  fi
  if [ -f "$TMUX_CONF" ] && grep -qF "$TMUX_SOURCE_LINE" "$TMUX_CONF"; then
    ok "tmux-gruvbox.conf sourced from ~/.tmux.conf"
  elif [ -f "$TMUX_CONF" ]; then
    printf '\n%s\n' "$TMUX_SOURCE_LINE" >> "$TMUX_CONF"
    linked "tmux-gruvbox.conf appended to ~/.tmux.conf"
  else
    printf '%s\n' "$TMUX_SOURCE_LINE" > "$TMUX_CONF"
    linked "tmux-gruvbox.conf → new ~/.tmux.conf"
  fi
}

setup_configure_ghostty() {
  if [ "${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}" = "1" ] || [ "${PI_ENV_SKIP_GHOSTTY:-0}" = "1" ]; then
    skip "~/.config/ghostty (managed externally)"
    return
  fi
  if [ "$should_link_ghostty" -eq 0 ]; then
    skip "~/.config/ghostty (not needed for $context_label; set PI_ENV_LINK_GHOSTTY=1 to force)"
    return
  fi

  if ! mkdir -p "$GHOSTTY_CONFIG_DIR/themes" 2>/dev/null; then
    skip "~/.config/ghostty (cannot create $GHOSTTY_CONFIG_DIR)"
    return
  fi

  link_entries \
    "$REPO/ghostty/config|$GHOSTTY_CONFIG_DIR/config|~/.config/ghostty/config" \
    "$REPO/ghostty/themes/pi-env-gruvbox-dark|$GHOSTTY_CONFIG_DIR/themes/pi-env-gruvbox-dark|~/.config/ghostty/themes/pi-env-gruvbox-dark" \
    "$REPO/ghostty/themes/pi-env-gruvbox-light|$GHOSTTY_CONFIG_DIR/themes/pi-env-gruvbox-light|~/.config/ghostty/themes/pi-env-gruvbox-light"
}

setup_configure_terminal_tools() {
  section "Terminal tools"
  if [ "${PI_ENV_SKIP_TERMINAL:-0}" = "1" ]; then
    skip "terminal tools (disabled by setup option)"
    return
  fi
  setup_configure_tmux
  setup_configure_ghostty
}

setup_configure_repo_tools() {
  section "Repo tools"
  if [ "${PI_ENV_SKIP_REPO_HOOKS:-0}" = "1" ]; then
    skip "repo hooks (disabled by setup option)"
    return
  fi

  GIT_DIR="$(git -C "$REPO" rev-parse --absolute-git-dir)"
  GIT_COMMON_DIR="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)"
  if [ "$GIT_DIR" != "$GIT_COMMON_DIR" ]; then
    skip "post-merge hook (worktree checkout — run setup.sh in the primary checkout to update shared hooks)"
  else
    HOOK_DST="$GIT_COMMON_DIR/hooks/post-merge"
    mkdir -p "$(dirname "$HOOK_DST")"
    if [ -L "$HOOK_DST" ] && [ "$(readlink "$HOOK_DST")" = "$HOOK_SRC" ]; then
      ok "post-merge hook"
    elif [ -e "$HOOK_DST" ] && [ ! -L "$HOOK_DST" ]; then
      skip "post-merge hook (custom hook already exists at .git/hooks/post-merge)"
    else
      ln -sfn "$HOOK_SRC" "$HOOK_DST"
      chmod +x "$HOOK_SRC"
      linked "post-merge hook → setup/post-merge"
    fi
  fi
}

setup_print_done() {
  echo ""
  echo "Done."
  echo "  Setup mode:     ${PI_ENV_SETUP_MODE:-portable}"
  echo "  Pi CLI:         $PI_BIN_DIR/pi"
  echo "  Machine config: ~/.pi/agent/{auth.json,settings.json}"
  echo "  Install check:  cd $REPO && npm run verify:install"
  echo "  Merge check:    cd $REPO && npm run verify"
}
