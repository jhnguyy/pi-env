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
  local node_bin result
  node_bin=$(resolve_setup_node_bin)
  result=$("$node_bin" "$SETUP_DIR/apply-managed-settings.mjs" "$SETTINGS_FILE" "$MANAGED_SETTINGS_FILE" "$REPO")
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
  if setup_external_config_managed || [ "${PI_ENV_SKIP_TMUX:-0}" = "1" ]; then
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
  if setup_external_config_managed || [ "${PI_ENV_SKIP_GHOSTTY:-0}" = "1" ]; then
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

setup_install_git_hook() {
  local name="$1" src="$2" dst="$GIT_COMMON_DIR/hooks/$name"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    ok "$name hook"
  elif [ -e "$dst" ] && [ ! -L "$dst" ]; then
    skip "$name hook (custom hook already exists at .git/hooks/$name)"
  else
    ln -sfn "$src" "$dst"
    chmod +x "$src"
    linked "$name hook → setup/$name"
  fi
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
    skip "repo hooks (worktree checkout — run setup.sh in the primary checkout to update shared hooks)"
  else
    setup_install_git_hook post-merge "$POST_MERGE_HOOK_SRC"
    setup_install_git_hook pre-commit "$PRE_COMMIT_HOOK_SRC"
  fi
}

setup_print_done() {
  echo ""
  echo "Done."
  echo "  Setup mode:     ${PI_ENV_SETUP_MODE:-portable}"
  echo "  Pi CLI:         $PI_BIN_DIR/pi"
  echo "  Machine config: ~/.pi/agent/{auth.json,settings.json}"
  echo "  Install check:  cd $REPO && nub run verify:install"
  echo "  Merge check:    cd $REPO && nub run verify"
}
