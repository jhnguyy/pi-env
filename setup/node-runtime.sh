#!/usr/bin/env sh
# Shared Node runtime selection for setup bootstrap and package scripts.
# Keep this dependency-free: it runs before node_modules may exist.

pi_env_node_candidate_works() {
  candidate="${1:-}"
  repo="${2:-$(pwd)}"
  [ -n "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1
  "$candidate" "$repo/scripts/check-node-version.mjs" "$repo" >/dev/null 2>&1
}

pi_env_nub_node_candidate() {
  repo="${1:-$(pwd)}"
  command -v nub >/dev/null 2>&1 || return 1
  (cd "$repo" && nub node which 2>/dev/null) || return 1
}

pi_env_setup_nix_managed() {
  [ "${PI_ENV_SETUP_MODE:-portable}" = "nix-managed" ] || [ "${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}" = "1" ]
}

pi_env_select_node_bin() {
  repo="${1:-$(pwd)}"
  # Setup and the pi wrapper publish PI_ENV_NODE_BIN as the reusable runtime
  # boundary. Prefer it over ambient launcher metadata such as
  # NODE_EXECUTABLE, which Nub may set to an ELF loader rather than Node.
  if [ -n "${PI_ENV_NODE_BIN:-}" ]; then
    if pi_env_node_candidate_works "$PI_ENV_NODE_BIN" "$repo"; then
      printf '%s\n' "$PI_ENV_NODE_BIN"
      return 0
    fi
    echo "pi-env: PI_ENV_NODE_BIN is not usable: $PI_ENV_NODE_BIN" >&2
    return 127
  fi

  if [ -n "${NODE_EXECUTABLE:-}" ] && pi_env_node_candidate_works "$NODE_EXECUTABLE" "$repo"; then
    printf '%s\n' "$NODE_EXECUTABLE"
    return 0
  fi

  nub_node="$(pi_env_nub_node_candidate "$repo" || true)"
  if pi_env_node_candidate_works "$nub_node" "$repo"; then
    printf '%s\n' "$nub_node"
    return 0
  fi

  # Nix-managed setup means the host already owns the toolchain. If Nub is not
  # available, trust PATH before falling back to generic portable probes.
  if pi_env_setup_nix_managed; then
    path_node="$(command -v node 2>/dev/null || true)"
    if pi_env_node_candidate_works "$path_node" "$repo"; then
      printf '%s\n' "$path_node"
      return 0
    fi
  fi

  for candidate in /bin/node "$(command -v node 2>/dev/null || true)"; do
    if pi_env_node_candidate_works "$candidate" "$repo"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "pi-env: no usable Node.js matching package.json#engines.node found." >&2
  if command -v nix >/dev/null 2>&1; then
    echo "pi-env: next step: run ./setup.sh --use-nix, or provision Node with Nix/Home Manager and rerun ./setup.sh --nix-managed." >&2
  else
    echo "pi-env: next step: install Node.js matching package.json#engines.node, or set PI_ENV_NODE_BIN." >&2
  fi
  return 127
}

pi_env_exec_node() {
  repo="${PI_ENV_REPO:-$(pwd)}"
  node_bin="$(pi_env_select_node_bin "$repo")" || return $?
  exec "$node_bin" "$@"
}
