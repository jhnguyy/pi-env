import { StringEnum } from "@earendil-works/pi-ai";
import { Effect, Result } from "effect";
import { Type, type Static } from "typebox";

import { parseDiff } from "./parser";
import {
  captureDiffEffect,
  formatRunnerError,
  phaseErrorToRunResult,
  resolveGitRootEffect,
  runForExtensionEffect,
  type JitCatchPhaseError,
  type JitRunner,
} from "./runner";
import { err } from "../_shared/result";
import type { DomainToolContext, ToolContract } from "../_shared/tool-contract";

export const JIT_CATCH_PARAMETERS = Type.Object({
  behavior: Type.String({
    minLength: 1,
    description: "Named observable behavior or failure for the temporary experiment.",
  }),
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
      description: "Raw unified diff text. When provided, skips git entirely.",
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
  "Run a focused, temporary experiment for a named observable behavior or failure in an extension diff.",
  "A subagent writes the diagnostic, then the owning repository test script runs from the workspace root.",
  "Passing diagnostics are removed; failures and interruptions preserve them for inspection.",
].join("\n");

export interface JitCatchOperations {
  readonly resolveGitRoot: typeof resolveGitRootEffect;
  readonly captureDiff: typeof captureDiffEffect;
  readonly runForExtension: typeof runForExtensionEffect;
  readonly phaseErrorToRunResult: (
    extension: Parameters<typeof phaseErrorToRunResult>[0],
    error: JitCatchPhaseError,
    workspaceRoot: string,
  ) => ReturnType<typeof phaseErrorToRunResult>;
}

export const jitCatchOperations: JitCatchOperations = {
  resolveGitRoot: resolveGitRootEffect,
  captureDiff: captureDiffEffect,
  runForExtension: runForExtensionEffect,
  phaseErrorToRunResult,
};

export function createJitCatchContractWithRunner(
  runner: JitRunner,
  operations: JitCatchOperations = jitCatchOperations,
): ToolContract<JitCatchParams, unknown, typeof JIT_CATCH_PARAMETERS> {
  return {
    name: "jit_catch",
    label: "JiT-Catch",
    description: JIT_CATCH_DESCRIPTION,
    parameters: JIT_CATCH_PARAMETERS,
    execute: (params, context) =>
      Effect.runPromise(executeJitCatchEffect(params, runner, context, operations), {
        signal: context.signal,
      }),
  };
}

function executeJitCatchEffect(
  params: JitCatchParams,
  runner: JitRunner,
  context: DomainToolContext,
  operations: JitCatchOperations = jitCatchOperations,
) {
  const progress = context.progress ?? (() => {});

  return Effect.gen(function* () {
    if (!params.behavior?.trim()) {
      return err("jit_catch requires a named observable behavior or failure");
    }

    let diffText: string;
    let workspaceRoot = params.git_cwd ?? context.cwd;
    progress("Acquiring diff…");

    const acquisition = yield* Effect.result(
      Effect.gen(function* () {
        if (params.diff !== undefined) {
          return params.diff;
        }

        const source = params.diff_source ?? "unstaged";
        const gitCwd = params.git_cwd ?? context.cwd;
        workspaceRoot = yield* operations.resolveGitRoot(runner, gitCwd);
        return yield* operations.captureDiff(source, runner, gitCwd, params.commit);
      }),
    );

    if (Result.isFailure(acquisition)) return err(formatRunnerError(acquisition.failure));
    diffText = acquisition.success;

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
      const result = yield* Effect.result(
        operations.runForExtension(
          ext,
          diffText,
          runner,
          workspaceRoot,
          params.behavior.trim(),
          (phase: string) => {
            progress(`${ext.name}: ${phase}`);
          },
        ),
      );
      results.push(
        Result.isSuccess(result)
          ? result.success
          : operations.phaseErrorToRunResult(ext, result.failure, workspaceRoot),
      );
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
        lines.push(
          `  Output:\n${r.testOutput
            .split("\n")
            .map((l: string) => "  " + l)
            .join("\n")}`,
        );
      }
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { results, anyFailed },
    };
  });
}
