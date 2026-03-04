---
name: jit-catch
description: Run the jit_catch tool to generate and execute ephemeral catching tests for pi extension diffs. Use after editing any file in ~/.pi/agent/extensions/*/ to verify the change does not introduce bugs. The tool auto-acquires the diff, spawns a test-writer subagent, runs bun test, and discards passing tests. Never commits test files.
---

# JiT-Catch

## Taxonomy

**Hardening tests:** Validate requirements/contracts that must never regress. Committed to repo.

**Catching tests:** Ephemeral verification for a specific diff. Run once, then discarded. Never committed.

## Decision Rule

Use `jit_catch` when:
- Making changes to extension files (`~/.pi/agent/extensions/*/`)
- You have changes to verify
- No existing hardening test covers the changed surface. To check (substitute real values):
  ```bash
  grep -r '<changed-function-name>' ~/.pi/agent/extensions/<ext-name>/__tests__/ 2>/dev/null
  # e.g.: grep -r 'parseDiff' ~/.pi/agent/extensions/jit-catch/__tests__/ 2>/dev/null
  ```
  No output means likely not covered.

Use `bun test` directly (no subagent) when:
- Change is already covered by hardening tests in `__tests__/`
- Working on files outside extension directories

## Usage

```
jit_catch({ diff_source: "unstaged" })                            # default — verifies unstaged git changes
jit_catch({ diff_source: "staged" })                              # verifies staged changes
jit_catch({ diff_source: "commit", commit: "abc1234" })           # specific commit
jit_catch({ diff: "<raw unified diff>" })                         # bypass git entirely
jit_catch({ diff_source: "unstaged", ext_name: "tmux" })          # target one extension in a multi-ext diff
jit_catch({ diff_source: "unstaged", git_cwd: "/root/myrepo" })  # override where git runs
```

Generated test file path: `~/.pi/agent/extensions/<ext-name>/__tests__/<ext-name>.catching.test.ts`
— auto-deleted on pass; kept at that path on fail.

**Multi-extension diffs:** without `ext_name`, the tool runs the full workflow for each changed extension in sequence.

**Availability:** registered by `~/.pi/agent/extensions/jit-catch/`. If the tool is missing, restart pi to reload extensions.

## What the tool does automatically

1. Acquires the diff (via git or `diff` param)
2. Parses which extensions changed (ignores non-extension files, `__tests__/`, `node_modules`)
3. Prepares env — creates `__tests__/` and a minimal `package.json` if absent
4. Spawns a subagent to write 2–4 catching tests targeting the changed surface
5. Runs `bun test` on the generated file
6. Pass → auto-discards. Fail → keeps file and surfaces output.

## On failure

- **Test is correct, code is wrong** → fix the code, then either re-run `jit_catch` (which will re-generate and auto-discard on pass) or run directly:
  ```bash
  cd ~/.pi/agent/extensions/<ext-name>
  bun test __tests__/<ext-name>.catching.test.ts
  # then: rm __tests__/<ext-name>.catching.test.ts
  ```
- **Test is wrong** → edit the kept file at `~/.pi/agent/extensions/<ext-name>/__tests__/<ext-name>.catching.test.ts`, re-run `bun test` as above, then delete it.

## Promoting to hardening

Rename `<ext-name>.catching.test.ts` → `<ext-name>.test.ts` (drop `.catching`) only if the test:
- Validates a public API requirement, or
- Prevents a known regression

Run `bun test` in the extension directory to confirm the full suite still passes.
