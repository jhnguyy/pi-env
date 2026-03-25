/**
 * JiT-Catch Extension — entry point.
 *
 * Provides the `jit_catch` tool, which automates the full catching-test
 * workflow for pi extension diffs:
 *
 *   1. Acquire diff (via git or raw param)
 *   2. Parse which extensions changed
 *   3. Prepare test environment
 *   4. Spawn a subagent to generate ephemeral catching tests
 *   5. Run `bun test` on the generated file
 *   6. Auto-discard on pass; surface test output on fail
 *
 * Decision rule (when to use vs `bun test` directly) lives in the updated
 * jit-catch skill, which is now much thinner.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";

import { parseDiff } from "./parser";
import { captureDiff, runForExtension } from "./runner";
import { err } from "../_shared/result";
import type { ExtToolRegistration } from "../subagent/types";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "jit_catch",
    label: "JiT-Catch",
    description: [
      "Generate and run ephemeral catching tests for a code diff against extension files.",
      "Tests are written by a subagent, executed with bun test, then auto-discarded on pass.",
      "Never commits test files.",
      "",
      "## Taxonomy",
      "Hardening tests: committed, validate requirements that must never regress.",
      "Catching tests: ephemeral, verify this specific diff once, then discarded.",
      "",
      "## When to use",
      "Use jit_catch for changes to extension files with NO existing hardening test coverage.",
      "Use `bun test` directly if coverage already exists in __tests__/, or for non-extension files.",
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
      "at ~/.pi/agent/extensions/<ext-name>/__tests__/<ext-name>.catching.test.ts, then",
      "`bun test` and `rm` it. Use the jit-catch skill for promoting criteria.",
    ].join("\n"),

    parameters: Type.Object({
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
            "Working directory for git commands. Defaults to the agent's current working directory.",
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
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const exec = pi.exec.bind(pi);

      const progress = (msg: string) =>
        onUpdate?.({ content: [{ type: "text", text: msg }], details: { phase: msg } });

      // ─── 1. Acquire diff ──────────────────────────────────────
      let diffText: string;
      progress("Acquiring diff…");
      try {
        if (params.diff) {
          diffText = params.diff;
        } else {
          const source = params.diff_source ?? "unstaged";
          const gitCwd = params.git_cwd ?? ctx.cwd;
          diffText = await captureDiff(source, exec, gitCwd, params.commit);
        }
      } catch (e) {
        return err(String(e));
      }

      // ─── 2. Parse extensions from diff ────────────────────────
      const { extensions, hasNonExtensionFiles } = parseDiff(diffText);

      if (extensions.length === 0) {
        const hint = hasNonExtensionFiles
          ? "Diff only touches non-extension files — jit-catch does not apply."
          : "No changed files found in the diff.";
        return err(hint);
      }

      // ─── 3. Filter by ext_name override if provided ───────────
      const targets = params.ext_name
        ? extensions.filter((e) => e.name === params.ext_name)
        : extensions;

      if (targets.length === 0) {
        return err(
          `Extension '${params.ext_name}' not found in diff. ` +
          `Extensions present: ${extensions.map((e) => e.name).join(", ")}`,
        );
      }

      progress(`Found ${targets.length} extension(s): ${targets.map(e => e.name).join(", ")}`);

      // ─── 4. Run workflow for each extension ───────────────────
      const results = [];
      for (const ext of targets) {
        progress(`${ext.name}: generating tests…`);
        const result = await runForExtension(ext, diffText, exec, signal, (phase) => {
          progress(`${ext.name}: ${phase}`);
        });
        results.push(result);
      }

      // ─── 5. Format output ─────────────────────────────────────
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

      const summary = lines.join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { results, anyFailed },
      };
    },

    renderCall(args, theme, _ctx) {
      let text = theme.fg("toolTitle", theme.bold("jit_catch"));
      const source = args.diff ? "raw diff" : (args.diff_source ?? "unstaged");
      text += " " + theme.fg("accent", source);
      if (args.ext_name) text += " " + theme.fg("muted", args.ext_name);
      if (args.commit) text += " " + theme.fg("dim", args.commit.slice(0, 8));
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme, _ctx) {
      const details = result.details as { anyFailed?: boolean } | null;
      const failed = details?.anyFailed ?? false;
      const first = result.content[0];
      const text = first?.type === "text" ? first.text.split("\n")[0] ?? "" : "";

      const isError =
        failed ||
        (details != null && typeof details === "object" && "error" in details);
      if (isError) {
        return new Text(theme.fg("error", "✗ " + text), 0, 0);
      }
      return new Text(theme.fg("success", text), 0, 0);
    },
  });

  // Register jit_catch as an AgentTool so subagents (e.g. code-review agents) can run catching tests.
  // Uses process.cwd() for git operations since subagents run in-process and share the same cwd.
  // Capabilities: write (creates temp test files), execute (runs bun test).
  pi.on("session_start", () => {
    const exec = pi.exec.bind(pi);
    const jitAgentTool: AgentTool<any, any> = {
      name: "jit_catch",
      label: "JiT-Catch",
      description: "Generate and run ephemeral catching tests for a code diff. Tests are written by a subagent, executed with bun test, then auto-discarded on pass.",
      parameters: Type.Object({
        diff_source: Type.Optional(StringEnum(["unstaged", "staged", "commit"] as const, { description: "How to acquire the diff. Default: 'unstaged'." })),
        commit: Type.Optional(Type.String({ description: "Commit SHA — required when diff_source='commit'." })),
        git_cwd: Type.Optional(Type.String({ description: "Working directory for git commands. Defaults to process.cwd()." })),
        diff: Type.Optional(Type.String({ description: "Raw unified diff text. When provided, skips git entirely." })),
        ext_name: Type.Optional(Type.String({ description: "Override auto-detected extension name." })),
      }),
      execute: async (_toolCallId, params, signal) => {
        let diffText: string;
        try {
          if (params.diff) {
            diffText = params.diff;
          } else {
            const source = params.diff_source ?? "unstaged";
            const gitCwd = params.git_cwd ?? process.cwd();
            diffText = await captureDiff(source, exec, gitCwd, params.commit);
          }
        } catch (e) { return err(String(e)); }
        const { extensions, hasNonExtensionFiles } = parseDiff(diffText);
        if (extensions.length === 0) return err(hasNonExtensionFiles ? "Diff only touches non-extension files." : "No changed files found.");
        const targets = params.ext_name ? extensions.filter((e) => e.name === params.ext_name) : extensions;
        if (targets.length === 0) return err(`Extension '${params.ext_name}' not found. Present: ${extensions.map((e) => e.name).join(", ")}`);
        const results = [];
        for (const ext of targets) {
          const result = await runForExtension(ext, diffText, exec, signal, () => {});
          results.push(result);
        }
        const lines: string[] = [];
        if (hasNonExtensionFiles) lines.push("Note: diff also contains non-extension files (ignored).\n");
        let anyFailed = false;
        for (const r of results) {
          if (r.passed) { lines.push(`✓ ${r.extName} — tests passed.`); }
          else { anyFailed = true; lines.push(`✗ ${r.extName} — FAILED.\n${r.testOutput}`); }
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { results, anyFailed } };
      },
    };
    pi.events.emit("agent-tools:register", { tool: jitAgentTool, capabilities: ["write", "execute"] } satisfies ExtToolRegistration);
  });
}

// err imported from ../_shared/result
