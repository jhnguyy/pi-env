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
  setup/__tests__/managed-settings.test.sh
  setup/__tests__/nix-managed-config.test.sh
  setup/__tests__/setup-options.test.sh
  setup/__tests__/policy.test.sh
  setup/__tests__/node-policy.test.sh
  setup/__tests__/repo-hooks.test.sh
  setup/__tests__/node-resolution.test.sh
  setup/__tests__/pi-cli-wrapper.test.sh
  setup/__tests__/verify-install.test.sh
  setup/__tests__/verify.test.sh
)

for test_script in "${SETUP_TESTS[@]}"; do
  bash "$test_script"
done
