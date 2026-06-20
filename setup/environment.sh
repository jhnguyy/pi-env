#!/usr/bin/env bash
# Environment detection and prerequisite reporting.

setup_detect_environment() {
  case "$(uname -s)" in
    Darwin) os_label="macOS" ;;
    Linux) os_label="Linux" ;;
    *) os_label="$(uname -s)" ;;
  esac

  is_devcontainer=0
  if [ -n "${DEVCONTAINER:-}" ] || [ -n "${REMOTE_CONTAINERS:-}" ] || [ -n "${CODESPACES:-}" ] || [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
    is_devcontainer=1
  fi

  virt_label="none"
  if command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt --quiet 2>/dev/null; then
    virt_label="$(systemd-detect-virt 2>/dev/null || printf 'unknown')"
  fi

  if [ "$is_devcontainer" -eq 1 ]; then
    context_label="devcontainer"
  elif [ "$virt_label" != "none" ]; then
    context_label="vm/container:$virt_label"
  else
    context_label="host"
  fi

  has_gui=0
  if [ "$os_label" = "macOS" ] || [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
    has_gui=1
  fi

  should_link_ghostty=0
  if [ "${PI_ENV_LINK_GHOSTTY:-}" = "1" ]; then
    should_link_ghostty=1
  elif [ "$is_devcontainer" -eq 0 ] && [ "$has_gui" -eq 1 ]; then
    should_link_ghostty=1
  fi
}

setup_check_prerequisites() {
  section "Prerequisites"

  check_required_commands git node bun
  setup_detect_environment

  echo "  —  platform: $os_label"
  echo "  —  context: $context_label"
  check_recommended_commands tmux gh rg

  if [ "$should_link_ghostty" -eq 1 ]; then
    if command -v ghostty >/dev/null 2>&1; then
      ok "ghostty"
    else
      echo "  —  ghostty not found (recommended for GUI hosts/VMs; see setup/prerequisites.md)"
    fi
    echo "  —  font: JetBrains Mono recommended for Ghostty"
  else
    echo "  —  ghostty skipped for $context_label (set PI_ENV_LINK_GHOSTTY=1 to force linking)"
  fi
}
