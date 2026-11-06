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

test_agent_guidelines_are_created_from_the_managed_source
test_agent_guidelines_are_reconciled_idempotently

echo "agent guideline tests passed"
