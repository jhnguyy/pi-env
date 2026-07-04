#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
cd "$ROOT"

"$(node_bin)" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { deriveSetupPolicy, isCliManagedExternally, isNixManaged, setupMode, shouldSkipPathProfile } from './setup/policy.mjs';

const portable = deriveSetupPolicy({});
assert.equal(portable.mode, 'portable');
assert.equal(portable.cli.writeWrapper, true);
assert.equal(portable.path.updateShellProfiles, true);
assert.equal(portable.terminal.enabled, true);
assert.equal(portable.terminal.tmux.configure, true);
assert.equal(portable.terminal.ghostty.configure, true);
assert.equal(portable.repoTools.installHooks, true);

const nix = deriveSetupPolicy({ PI_ENV_CONFIG_MANAGED_BY_NIX: '1' });
assert.equal(nix.mode, 'nix-managed');
assert.equal(nix.nixManaged, true);
assert.equal(nix.path.updateShellProfiles, false);
assert.equal(nix.terminal.tmux.configure, false);
assert.equal(nix.terminal.ghostty.configure, false);

const granular = deriveSetupPolicy({
  PI_ENV_SKIP_TERMINAL: '1',
  PI_ENV_SKIP_REPO_HOOKS: '1',
  PI_ENV_SKIP_PATH_PROFILE: '1',
  PI_ENV_CLI_MANAGED_BY_NIX: '1',
});
assert.equal(granular.terminal.enabled, false);
assert.equal(granular.repoTools.installHooks, false);
assert.equal(granular.path.updateShellProfiles, false);
assert.equal(granular.cli.writeWrapper, false);

assert.equal(setupMode({ PI_ENV_SETUP_MODE: 'nix-managed' }), 'nix-managed');
assert.equal(isNixManaged({ PI_ENV_SETUP_MODE: 'nix-managed' }), true);
assert.equal(isCliManagedExternally({ PI_ENV_CLI_MANAGED_BY_NIX: '1' }), true);
assert.equal(shouldSkipPathProfile({ PI_ENV_SKIP_PATH_PROFILE: '1' }), true);
JS

echo "setup policy tests passed"
