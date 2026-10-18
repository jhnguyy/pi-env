#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

START_MARKER='<!-- pi-env:agent-guidelines:start -->'
END_MARKER='<!-- pi-env:agent-guidelines:end -->'

configure_pi() {
  local home="$1"
  REPO="$ROOT" \
  SETUP_DIR="$ROOT/setup" \
  SETTINGS_FILE="$home/.pi/agent/settings.json" \
  AGENTS_DIR="$home/.agents" \
  TEST_UTILS_DIR="$home/.pi/agent/extensions/__tests__" \
  APPEND_SRC="$ROOT/.pi/agent/APPEND_SYSTEM.md" \
  APPEND_DST="$home/.pi/agent/APPEND_SYSTEM.md" \
  PI_AGENT_DIR="$home/.pi/agent" \
  TMUX_CONF="$home/.tmux.conf" \
  TMUX_SOURCE_LINE="source-file $ROOT/setup/templates/tmux.conf" \
  GHOSTTY_CONFIG_DIR="$home/.config/ghostty" \
  POST_MERGE_HOOK_SRC="$ROOT/setup/hooks/post-merge" \
  PRE_COMMIT_HOOK_SRC="$ROOT/setup/hooks/pre-commit" \
  run_node "$ROOT/setup/configure.mjs" pi "$(node_bin)" >/dev/null
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

test_append_system_setup_and_loading() {
  local evidence home append_file
  evidence="$(with_temp_dir)"
  home="$evidence/home"
  append_file="$home/.pi/agent/APPEND_SYSTEM.md"
  echo "Append-system evidence: $evidence"
  printf '%s\n' 'Reproduce: bash setup/__tests__/agent-guidelines.test.sh' >"$evidence/README.txt"

  configure_pi "$home"
  cp "$append_file" "$evidence/fresh.md"
  assert_file_count "$append_file" '<!-- pi-env:append-system:start -->' 1
  assert_file_count "$append_file" '<!-- pi-env:append-system:end -->' 1

  printf '%s\n' '<!-- pi-env:append-system -->' '<!-- pi-env:append-system -->' \
    'Keep this personal rule.' '' '  Keep this spacing.  ' >"$append_file"
  cp "$append_file" "$evidence/legacy.md"
  configure_pi "$home"
  cp "$append_file" "$evidence/upgraded.md"

  run_node --input-type=module - "$ROOT" "$evidence" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
const [root, evidence] = process.argv.slice(2);
const path = join(evidence, "home/.pi/agent/APPEND_SYSTEM.md");
const source = readFileSync(join(root, ".pi/agent/APPEND_SYSTEM.md"), "utf8").trim();
const expected = `<!-- pi-env:append-system:start -->\n${source}\n<!-- pi-env:append-system:end -->`;
const upgraded = readFileSync(path, "utf8");
const legacy = readFileSync(join(evidence, "legacy.md"), "utf8");
assert.equal(upgraded.slice(0, legacy.length), legacy, "legacy text must remain unchanged");
assert.ok(upgraded.includes(expected));
const cwd = join(evidence, "project");
mkdirSync(cwd);
const loader = new DefaultResourceLoader({
  cwd, agentDir: join(evidence, "home/.pi/agent"),
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
});
await loader.reload();
assert.ok(loader.getAppendSystemPrompt().includes(upgraded));
writeFileSync(join(evidence, "loaded.json"), JSON.stringify(loader.getAppendSystemPrompt(), null, 2));
const reconciled = upgraded + "\n  Keep this trailing rule.  \n\n";
writeFileSync(join(evidence, "expected-reconciled.md"), reconciled);
writeFileSync(path, reconciled.replace(source, "stale philosophy"));
NODE

  configure_pi "$home"
  cp "$append_file" "$evidence/reconciled.md"
  configure_pi "$home"
  run_node -e '
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const [actual, expected, previous] = process.argv.slice(1);
    const current = fs.readFileSync(actual, "utf8");
    assert.equal(current, fs.readFileSync(previous, "utf8"), "setup must be idempotent");
    assert.equal(current, fs.readFileSync(expected, "utf8"), "only the managed block may change");
  ' "$append_file" "$evidence/expected-reconciled.md" "$evidence/reconciled.md"
  printf '%s\n' '{"verdict":"pass","checks":["fresh","legacy","startup-loader","stale","idempotent","personal-preserved"]}' >"$evidence/result.json"
}

test_agent_guidelines_are_created_from_the_managed_source
test_agent_guidelines_are_reconciled_idempotently
test_append_system_setup_and_loading
test_managed_obsolete_roles_link_is_removed
test_user_owned_roles_file_is_preserved
test_unrelated_roles_link_is_preserved

echo "agent guideline tests passed"
