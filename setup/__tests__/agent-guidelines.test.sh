#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

START_MARKER='<!-- pi-env:agent-guidelines:start -->'
END_MARKER='<!-- pi-env:agent-guidelines:end -->'

configure_pi() {
  run_configure pi "$ROOT" "$1" >/dev/null
}

assert_managed_content() {
  local agents_file="$1"
  run_node -e '
    const fs = require("node:fs");
    const [agentsPath, sourcePath, start, end] = process.argv.slice(1);
    const actual = fs.readFileSync(agentsPath, "utf8");
    const source = fs.readFileSync(sourcePath, "utf8").trim();
    const expected = `${start}\n${source}\n${end}`;
    if (!actual.includes(expected)) {
      console.error("managed agent guidelines do not match their source");
      process.exit(1);
    }
  ' "$agents_file" "$ROOT/setup/templates/AGENTS.md" "$START_MARKER" "$END_MARKER"
}

test_agent_guidelines_are_created_from_the_managed_source() {
  local tmp home agents_file
  tmp="$(with_temp_dir)"
  home="$tmp/home"
  agents_file="$home/.pi/agent/AGENTS.md"

  configure_pi "$home"
  assert_file_count "$agents_file" "$START_MARKER" 1
  assert_file_count "$agents_file" "$END_MARKER" 1
  assert_managed_content "$agents_file"

  rm -rf "$tmp"
}

test_agent_guidelines_are_reconciled_idempotently() {
  local tmp home agents_file before after
  tmp="$(with_temp_dir)"
  home="$tmp/home"
  agents_file="$home/.pi/agent/AGENTS.md"
  mkdir -p "$(dirname "$agents_file")"
  printf '%s\n' '# Local instructions' '' 'Keep this local rule.' >"$agents_file"

  configure_pi "$home"
  assert_file_count "$agents_file" "$START_MARKER" 1
  assert_file_count "$agents_file" "$END_MARKER" 1
  assert_file_contains "$agents_file" 'Keep this local rule.'
  assert_managed_content "$agents_file"

  printf '%s\n' '' 'Keep this trailing rule.' >>"$agents_file"
  run_node -e '
    const fs = require("node:fs");
    const [path, start, end] = process.argv.slice(1);
    const current = fs.readFileSync(path, "utf8");
    const from = current.indexOf(start) + start.length;
    const to = current.indexOf(end);
    fs.writeFileSync(path, `${current.slice(0, from)}\nstale guidelines\n${current.slice(to)}`);
  ' "$agents_file" "$START_MARKER" "$END_MARKER"

  configure_pi "$home"
  assert_file_contains "$agents_file" 'Keep this local rule.'
  assert_file_contains "$agents_file" 'Keep this trailing rule.'
  assert_managed_content "$agents_file"

  before="$(sha256sum "$agents_file")"
  configure_pi "$home"
  after="$(sha256sum "$agents_file")"
  assert_eq "$after" "$before" 'a repeated setup must not change AGENTS.md'

  rm -rf "$tmp"
}

test_managed_obsolete_roles_link_is_removed() {
  local tmp home roles
  tmp="$(with_temp_dir)"
  home="$tmp/home"
  roles="$home/.agents/roles"
  mkdir -p "$(dirname "$roles")"
  ln -s "$ROOT/.agents/roles" "$roles"

  configure_pi "$home"
  if [ -e "$roles" ] || [ -L "$roles" ]; then
    fail "Pi setup must remove its obsolete roles link"
  fi

  rm -rf "$tmp"
}

test_user_owned_roles_file_is_preserved() {
  local tmp home roles
  tmp="$(with_temp_dir)"
  home="$tmp/home"
  roles="$home/.agents/roles"
  mkdir -p "$(dirname "$roles")"
  printf '%s\n' 'user-owned' >"$roles"

  configure_pi "$home"
  [ -f "$roles" ] || fail "Pi setup must preserve a user-owned roles file"
  assert_file_contains "$roles" 'user-owned'

  rm -rf "$tmp"
}

test_unrelated_roles_link_is_preserved() {
  local tmp home roles target
  tmp="$(with_temp_dir)"
  home="$tmp/home"
  roles="$home/.agents/roles"
  target="$tmp/custom-roles"
  mkdir -p "$(dirname "$roles")" "$target"
  ln -s "$target" "$roles"

  configure_pi "$home"
  [ -L "$roles" ] || fail "Pi setup must preserve an unrelated roles link"
  assert_eq "$(readlink "$roles")" "$target" "Pi setup must not replace an unrelated roles link"

  rm -rf "$tmp"
}

test_obsolete_test_links_are_removed() {
  local tmp home links user_links
  tmp="$(with_temp_dir)"
  # shellcheck disable=SC2064 # Expand now; the local is gone when the trap runs.
  trap "rm -rf '$tmp'" EXIT
  home="$tmp/home"
  links="$home/.pi/agent/extensions/__tests__"
  mkdir -p "$links"
  ln -s "$ROOT/.pi/extensions/__tests__/loader.test.ts" "$links/loader.test.ts"
  ln -s "$ROOT/.pi/extensions/__tests__/test-utils.ts" "$links/test-utils.ts"

  configure_pi "$home"
  [ ! -e "$links" ] && [ ! -L "$links" ] || fail "Pi setup must remove its obsolete test links and their empty directory"
  [ -d "$home/.pi/agent/extensions" ] || fail "Pi setup must keep the extensions directory"

  user_links="$tmp/user-home/.pi/agent/extensions/__tests__"
  mkdir -p "$user_links"
  ln -s "$ROOT/.pi/extensions/__tests__/loader.test.ts" "$user_links/loader.test.ts"
  printf '%s\n' 'user-owned' >"$user_links/test-utils.ts"
  configure_pi "$tmp/user-home"
  [ ! -L "$user_links/loader.test.ts" ] || fail "Pi setup must remove its obsolete loader link"
  assert_file_contains "$user_links/test-utils.ts" 'user-owned'

  # Earlier setup wrote the shell's logical path, so a symlinked checkout must still match.
  ln -s "$ROOT" "$tmp/checkout-alias"
  links="$tmp/alias-home/.pi/agent/extensions/__tests__"
  mkdir -p "$links"
  ln -s "$tmp/checkout-alias/.pi/extensions/__tests__/loader.test.ts" "$links/loader.test.ts"
  run_configure pi "$tmp/checkout-alias" "$tmp/alias-home" >/dev/null
  [ ! -e "$links" ] && [ ! -L "$links" ] || fail "Pi setup must remove obsolete links written through a symlinked checkout"

  rm -rf "$tmp"
  trap - EXIT
}

test_agent_guidelines_are_created_from_the_managed_source
test_agent_guidelines_are_reconciled_idempotently
test_obsolete_test_links_are_removed
test_managed_obsolete_roles_link_is_removed
test_user_owned_roles_file_is_preserved
test_unrelated_roles_link_is_preserved

echo "agent guideline tests passed"
