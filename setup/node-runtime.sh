#!/usr/bin/env sh
# Nix supplies the runtime; Nub selects it for portable setup.

pi_env_node_candidate_works() {
  candidate="${1:-}"
  repo="${2:-$(pwd)}"
  [ -n "$candidate" ] && [ -x "$candidate" ] || return 1
  "$candidate" "$repo/scripts/check-node-version.mjs" "$repo" >/dev/null 2>&1
}

pi_env_setup_nix_managed() {
  [ "${PI_ENV_SETUP_MODE:-portable}" = "nix-managed" ] || [ "${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}" = "1" ]
}

pi_env_nub_node_candidate() {
  repo="${1:-$(pwd)}"
  command -v nub >/dev/null 2>&1 || return 1
  (cd "$repo" && nub node which 2>/dev/null)
}

pi_env_select_node_bin() {
  repo="${1:-$(pwd)}"
  if [ -n "${PI_ENV_NODE_BIN:-}" ]; then
    candidate="$PI_ENV_NODE_BIN"
  elif pi_env_setup_nix_managed; then
    candidate="${NODE_EXECUTABLE:-$(command -v node 2>/dev/null || true)}"
  else
    candidate="$(pi_env_nub_node_candidate "$repo" || true)"
  fi
  if pi_env_node_candidate_works "$candidate" "$repo"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  echo "pi-env: no usable Node.js satisfies package.json#engines.node." >&2
  echo "pi-env: provision the Nix toolchain or use Nub's Node manager, then rerun setup." >&2
  return 127
}

pi_env_exec_node() {
  node_bin="$(pi_env_select_node_bin "${PI_ENV_REPO:-$(pwd)}")" || return $?
  exec "$node_bin" "$@"
}
