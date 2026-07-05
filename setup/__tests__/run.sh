#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

SETUP_TESTS=(
  setup/__tests__/managed-settings.test.sh
  setup/__tests__/nix-managed-config.test.sh
  setup/__tests__/setup-options.test.sh
  setup/__tests__/policy.test.sh
  setup/__tests__/repo-hooks.test.sh
  setup/__tests__/node-resolution.test.sh
  setup/__tests__/pi-cli-wrapper.test.sh
  setup/__tests__/verify-install.test.sh
  setup/__tests__/verify.test.sh
)

for test_script in "${SETUP_TESTS[@]}"; do
  bash "$test_script"
done
