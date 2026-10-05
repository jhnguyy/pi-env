#!/usr/bin/env bash
pi_env_resolve_agent_dir() {
  local native="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
  local legacy="${PI_AGENT_DIR:-$native}"
  case "$native" in
    "~") native="$HOME" ;;
    "~/"*) native="$HOME/${native#\~/}" ;;
  esac
  case "$legacy" in
    "~") legacy="$HOME" ;;
    "~/"*) legacy="$HOME/${legacy#\~/}" ;;
  esac
  if [[ "$native" != /* ]]; then native="$PWD/$native"; fi
  if [[ "$legacy" != /* ]]; then legacy="$PWD/$legacy"; fi
  if [ "$native" != "$legacy" ]; then
    echo "PI_AGENT_DIR and PI_CODING_AGENT_DIR must select the same directory." >&2
    return 2
  fi
  export PI_AGENT_DIR="$native" PI_CODING_AGENT_DIR="$native"
}
