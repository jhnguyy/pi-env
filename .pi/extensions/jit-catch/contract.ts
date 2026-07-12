import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { parseDiff } from "./parser";
import { captureDiff, resolveGitRoot, runForExtension, type ExecFn } from "./runner";
import { err } from "../_shared/result";
import type { DomainToolContext, ToolContract } from "../_shared/tool-contract";

export const JIT_CATCH_PARAMETERS = Type.Object({
  diff_source: Type.Optional(
    StringEnum(["unstaged", "staged", "commit"] as const, {
      description: "How to acquire the diff. Default: 'unstaged'.",
    }),
  ),
  commit: Type.Optional(
    Type.String({ description: "Commit SHA — required when diff_source='commit'." }),
  ),
  git_cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for git commands. Defaults to the adapter-provided current working directory.",
    }),
  ),
  diff: Type.Optional(
    Type.String({
      description:
        "Raw unified diff text. When provided, skips git entirely.",
    }),
  ),
  ext_name: Type.Optional(
    Type.String({
      description:
        "Override auto-detected extension name. Useful to target one extension in a multi-extension diff.",
    }),
  ),
});

export type JitCatchParams = Static<typeof JIT_CATCH_PARAMETERS>;

export const JIT_CATCH_DESCRIPTION = [
  "Generate and run ephemeral catching tests for a code diff against extension files.",
  "Tests are written by a subagent, executed with npm test, then auto-discarded on pass.",
  "Never commits test files.",
  "",
  "## Taxonomy",
  "Hardening tests: committed, validate requirements that must never regress.",
  "Catching tests: ephemeral, verify this specific diff once, then discarded.",
  "",
  "## When to use",
  "Use jit_catch for changes to extension files with NO existing hardening test coverage.",
  "Use `npm test` directly if coverage already exists in __tests__/, or for non-extension files.",
  "",
  "## Diff acquisition (pick one):",
  "  diff_source='unstaged' (default) — runs `git diff` in git_cwd",
  "  diff_source='staged'             — runs `git diff --cached` in git_cwd",
  "  diff_source='commit', commit=<SHA> — runs `git show <SHA>` in git_cwd",
  "  diff=<raw text>                  — skip git entirely, pass diff directly",
  "",
  "Optional: ext_name overrides auto-detected extension (useful for multi-extension diffs).",
  "",
  "## Symlink edge case (important for pi-env)",
  "If extension dir is symlinked to git repo, a previous failed run's file may remain staged.",
  "After every jit_catch run: `git status | grep catching` — expect no output.",
  "If any .catching.test.ts appears, `git restore` it before committing.",
  "",
  "## On failure",
  "Fix code, then re-run jit_catch (auto-discards on pass) or edit the kept test file",
  "at the reported path, then `npm test` and `rm` it. Use the jit-catch skill",
  "for promoting criteria.",
].join("\n");

export function createJitCatchContract(exec: ExecFn): ToolContract<JitCatchParams> {
  return {
    name: "jit_catch",
    label: "JiT-Catch",
    description: JIT_CATCH_DESCRIPTION,
    parameters: JIT_CATCH_PARAMETERS,
    execute: (params, context) => executeJitCatch(params, exec, context),
  };
}

async function executeJitCatch(
  params: JitCatchParams,
  exec: ExecFn,
  context: DomainToolContext,
) {
  const progress = context.progress ?? (() => {});

  let diffText: string;
  let workspaceRoot = params.git_cwd ?? context.cwd;
  progress("Acquiring diff…");
  try {
    if (params.diff) {
      workspaceRoot = await resolveGitRoot(exec, workspaceRoot);
      diffText = params.diff;
    } else {
      const source = params.diff_source ?? "unstaged";
      const gitCwd = params.git_cwd ?? context.cwd;
      workspaceRoot = await resolveGitRoot(exec, gitCwd);
      diffText = await captureDiff(source, exec, gitCwd, params.commit);
    }
  } catch (e) {
    return err(String(e));
  }

  const { extensions, hasNonExtensionFiles } = parseDiff(diffText);

  if (extensions.length === 0) {
    const hint = hasNonExtensionFiles
      ? "Diff only touches non-extension files — jit-catch does not apply."
      : "No changed files found in the diff.";
    return err(hint);
  }

  const targets = params.ext_name
    ? extensions.filter((e) => e.name === params.ext_name)
    : extensions;

  if (targets.length === 0) {
    return err(
      `Extension '${params.ext_name}' not found in diff. ` +
      `Extensions present: ${extensions.map((e) => e.name).join(", ")}`,
    );
  }

  progress(`Found ${targets.length} extension(s): ${targets.map((e) => e.name).join(", ")}`);

  const results = [];
  for (const ext of targets) {
    progress(`${ext.name}: generating tests…`);
    const result = await runForExtension(ext, diffText, exec, context.signal, workspaceRoot, (phase) => {
      progress(`${ext.name}: ${phase}`);
    });
    results.push(result);
  }

  const lines: string[] = [];
  if (hasNonExtensionFiles) {
    lines.push("Note: diff also contains non-extension files (ignored).\n");
  }

  let anyFailed = false;
  for (const r of results) {
    if (r.passed) {
      lines.push(`✓ ${r.extName} — tests passed, catching test discarded.`);
    } else {
      anyFailed = true;
      lines.push(`✗ ${r.extName} — tests FAILED.`);
      if (r.testPath) lines.push(`  Test file kept at: ${r.testPath}`);
      lines.push(`  Output:\n${r.testOutput.split("\n").map((l) => "  " + l).join("\n")}`);
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { results, anyFailed },
  };
}
