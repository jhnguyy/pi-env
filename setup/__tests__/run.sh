#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

# Resolve the real test runner Node once, before individual tests mutate HOME or
# PATH to simulate setup scenarios. This keeps shell tests aligned with the
# repository-declared Node version instead of falling back to a host /bin/node.
# shellcheck source=setup/node-runtime.sh
source "$ROOT/setup/node-runtime.sh"
if [ -z "${PI_ENV_TEST_NODE_BIN:-}" ]; then
  PI_ENV_TEST_NODE_BIN=$(pi_env_select_node_bin "$ROOT")
  export PI_ENV_TEST_NODE_BIN
fi

SETUP_TESTS=(
  setup/__tests__/settings-reset.test.sh
  setup/__tests__/managed-settings.test.sh
  setup/__tests__/agent-guidelines.test.sh
  setup/__tests__/append-system.test.sh
  setup/__tests__/nix-managed-config.test.sh
  setup/__tests__/setup-options.test.sh
  setup/__tests__/node-policy.test.sh
  setup/__tests__/repo-hooks.test.sh
  setup/__tests__/home-manager-sync.test.sh
  setup/__tests__/worktree-init.test.sh
  setup/__tests__/runtime-install-safety.test.sh
  setup/__tests__/node-resolution.test.sh
  setup/__tests__/pi-cli-wrapper.test.sh
  setup/__tests__/verify-install.test.sh
  setup/__tests__/effect-runtime.test.sh
  setup/__tests__/ghostty-config.test.sh
  setup/__tests__/effect-language-service.test.sh
)

# Tests set their own agent directory, Pi package, and Home Manager inputs. A Home Manager
# session exports personal values for these, so remove them before each test.
CALLER_STATE=(
  PI_AGENT_DIR PI_CODING_AGENT_DIR SETTINGS_FILE
  PI_PACKAGE_DIR PI_ENV_PI_EXECUTABLE PI_ENV_CLI_MANAGED_BY_NIX
  PI_ENV_HOME_MANAGER_FLAKE PI_ENV_HOME_MANAGER_INPUT
)
UNSET_CALLER_STATE=()
for name in "${CALLER_STATE[@]}"; do UNSET_CALLER_STATE+=(-u "$name"); done

for test_script in "${SETUP_TESTS[@]}"; do
  printf '\nsetup-test: start %s\n' "$test_script"
  started_at=$SECONDS
  if env "${UNSET_CALLER_STATE[@]}" bash "$test_script"; then
    status=0
  else
    status=$?
  fi
  printf 'setup-test: end %s status=%d elapsed=%ds\n' \
    "$test_script" "$status" "$((SECONDS - started_at))"
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
done
