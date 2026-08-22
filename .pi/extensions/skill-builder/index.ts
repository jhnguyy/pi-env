/**
 * Skill Builder Extension
 *
 * Provides:
 * - `skill_build` tool — scaffold, validate, or run one advisory evaluation
 *   for a skill
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, existsSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { Type } from "typebox";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import { Data, Effect, Result } from "effect";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { registerAgentToolsOnSessionStart, ToolCapability } from "../_shared/agent-tools";
import { WorkspaceAccess } from "../subagent/control";
import {
  runResolvedSubagentEffect,
  type ResolvedSubagentRun,
  type RunSubagentOptions,
} from "../subagent/execute";

const USER_REFERENCE_DIR = join(homedir(), ".agents", "skills", "reference");
const REFERENCE_SKILL_TOOL_DESCRIPTION =
  "Load a named reference skill only when the user explicitly asks for that skill. For example, the user can ask you to reference the teach skill to help with a topic. Call without a name only when the user asks which reference skills are available.";

interface ReferenceSkillEntry {
  readonly name: string;
  readonly filePath: string;
  readonly sourceDir: string;
}

/**
 * Lazy per-process index: skillName (lowercased) → reference skill entry.
 * Built on first reference_skill lookup; avoids re-reading all markdown files
 * on every invocation. Null = not yet built.
 */
let _referenceSkillIndex: Map<string, ReferenceSkillEntry> | null = null;

function findPackageReferenceDir(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 8; i += 1) {
    const packageJson = join(current, "package.json");
    const referenceDir = join(current, ".agents", "skills", "reference");
    if (existsSync(packageJson) && existsSync(referenceDir)) {
      return referenceDir;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

export function getReferenceDirs(): string[] {
  const dirs = [USER_REFERENCE_DIR, findPackageReferenceDir()].filter((dir): dir is string =>
    Boolean(dir && existsSync(dir)),
  );
  return Array.from(new Set(dirs.map((dir) => resolve(dir))));
}

function readReferenceSkillName(filePath: string, fallback: string): string {
  const content = readFileSync(filePath, "utf-8");
  const nameMatch = content.match(/^---[\s\S]*?^name:\s*(.+?)\s*$/m);
  return nameMatch ? nameMatch[1].trim() : fallback;
}

export function listReferenceSkillNames(): string[] {
  const names = new Set<string>();
  for (const dir of getReferenceDirs()) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      names.add(file.replace(/\.md$/, ""));
    }
  }
  return Array.from(names).sort();
}

export function getReferenceSkillIndex(): Map<string, ReferenceSkillEntry> {
  if (_referenceSkillIndex !== null) return _referenceSkillIndex;
  const index = new Map<string, ReferenceSkillEntry>();

  for (const dir of getReferenceDirs()) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const filePath = join(dir, file);
      const filenameKey = file.replace(/\.md$/, "");
      const skillName = readReferenceSkillName(filePath, filenameKey);
      const entry = { name: skillName, filePath, sourceDir: dir };

      // First directory wins so user-level reference skills can override package defaults.
      if (!index.has(skillName.toLowerCase())) index.set(skillName.toLowerCase(), entry);
      if (!index.has(filenameKey.toLowerCase())) index.set(filenameKey.toLowerCase(), entry);
    }
  }

  _referenceSkillIndex = index;
  return index;
}

import { buildEvalPrompt, parseEvalResponse, type EvalModelConfig } from "./evaluator";
import { resolveSkillDiff, type ExecFn } from "./git-diff";
import { scaffoldSkill, DEFAULT_SKILLS_DIR } from "./scaffolder";
import type { EvaluationResult, ValidationResult } from "./types";
import { validateSkill } from "./validator";
import {
  noopToolingDiagnostics,
  withToolingTelemetryRuntime,
  type ToolingDiagnostics,
} from "../../../src/telemetry/tooling.js";

type ReferenceSkillParams = { name?: string };
type SkillBuildParams = {
  name?: string;
  description?: string;
  template?: "basic" | "with-scripts" | "with-index";
  targetDir?: string;
  path?: string;
  action?: "validate" | "evaluate";
  goal?: string;
};

type TextResult = Omit<AgentToolResult<unknown>, "content"> & {
  content: Array<{ type: "text"; text: string }>;
};

type SkillBuildOptions = {
  cwd: string;
  signal?: AbortSignal;
  ctx?: ExtensionContext;
  allowEvaluation?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  telemetryExporter?: SpanExporter;
};

type EvaluationRunner = typeof runResolvedSubagentEffect;
let evaluationRunner: EvaluationRunner = runResolvedSubagentEffect;

export function setSkillEvaluationRunnerForTests(runner: EvaluationRunner): void {
  evaluationRunner = runner;
}

export function resetSkillEvaluationRunnerForTests(): void {
  evaluationRunner = runResolvedSubagentEffect;
}

const SkillBuildOperation = {
  Scaffold: "scaffold",
  Validate: "validate",
  Diff: "diff",
  FileRead: "file_read",
  Evaluate: "evaluate",
  Run: "skill_build",
} as const;
type SkillBuildOperation = Exclude<
  (typeof SkillBuildOperation)[keyof typeof SkillBuildOperation],
  typeof SkillBuildOperation.Run
>;

const SkillBuildSpanName = {
  Workflow: "tooling.skill_build.workflow",
  Scaffold: "tooling.skill_build.scaffold",
  Validate: "tooling.skill_build.validate",
  Diff: "tooling.skill_build.diff",
  Evaluate: "tooling.skill_build.evaluate",
} as const;

export class SkillBuildOperationalError extends Data.TaggedError("SkillBuildOperationalError")<{
  readonly operation: SkillBuildOperation;
  readonly message: string;
}> {}

const SkillBuildMode = {
  Create: "create",
  Validate: "validate",
  Evaluate: "evaluate",
} as const;

type SkillBuildMode =
  | {
      _tag: typeof SkillBuildMode.Create;
      name: string;
      description: string;
      template: NonNullable<SkillBuildParams["template"]>;
      targetDir?: string;
    }
  | {
      _tag: typeof SkillBuildMode.Validate;
      path: string;
    }
  | {
      _tag: typeof SkillBuildMode.Evaluate;
      path: string;
      goal: string;
    };

type SkillBuildModeResolution =
  | { _tag: "valid"; mode: SkillBuildMode }
  | { _tag: "invalid"; message: string };

const REFERENCE_SKILL_PARAMETERS = Type.Object({
  name: Type.Optional(
    Type.String({ description: "Skill name to load. Omit to list available skills." }),
  ),
});

const SKILL_BUILD_PARAMETERS = Type.Object({
  name: Type.Optional(
    Type.String({
      description:
        "New skill name. Use lowercase letters, digits, and hyphens only. Starts the create workflow.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "Describe what the skill does and when to use it. Keep it specific. Use no more than 1024 characters.",
    }),
  ),
  template: Type.Optional(
    StringEnum(["basic", "with-scripts", "with-index"] as const, {
      description:
        'Use "basic" for concise skills. Use "with-index" only when supporting references are necessary.',
    }),
  ),
  targetDir: Type.Optional(
    Type.String({
      description: `Target parent directory for new skill. Default: ${DEFAULT_SKILLS_DIR}`,
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Path to an existing skill directory. Defaults to deterministic validation.",
    }),
  ),
  action: Type.Optional(
    StringEnum(["validate", "evaluate"] as const, {
      description:
        'Use "validate" for deterministic checks. Use "evaluate" for one advisory subagent review.',
    }),
  ),
  goal: Type.Optional(
    Type.String({
      description: "User-requested outcome that defines the scope of advisory evaluation.",
    }),
  ),
});

function textResult(text: string, details: unknown = null, usage?: Usage): TextResult {
  return { content: [{ type: "text", text }], details, usage };
}

export function executeReferenceSkill(params: ReferenceSkillParams): TextResult {
  const referenceDirs = getReferenceDirs();
  if (referenceDirs.length === 0) {
    return textResult(`No reference skill directories found. Checked: ${USER_REFERENCE_DIR}`, {
      referenceDirs,
    });
  }

  if (!params.name) {
    const names = listReferenceSkillNames();
    return textResult(
      `Available reference skills:\n${names.map((n: string) => `  - ${n}`).join("\n")}`,
      { referenceDirs },
    );
  }

  const index = getReferenceSkillIndex();
  const matched = index.get(params.name.toLowerCase()) ?? null;
  if (!matched) {
    const names = listReferenceSkillNames();
    return textResult(`No reference skill named "${params.name}". Available: ${names.join(", ")}`, {
      referenceDirs,
    });
  }

  return textResult(readFileSync(matched.filePath, "utf-8"), matched);
}

function invalidMode(message: string): SkillBuildModeResolution {
  return { _tag: "invalid", message: `✗ ${message}` };
}

function resolveCreateMode(params: SkillBuildParams): SkillBuildModeResolution {
  if (!params.name || !params.description || !params.template) {
    return invalidMode("Create mode requires name, description, and template.");
  }
  if (params.action || params.goal) {
    return invalidMode("Create mode does not accept action or goal.");
  }
  return {
    _tag: "valid",
    mode: {
      _tag: SkillBuildMode.Create,
      name: params.name,
      description: params.description,
      template: params.template,
      targetDir: params.targetDir,
    },
  };
}

function resolveExistingMode(params: SkillBuildParams): SkillBuildModeResolution {
  const action = params.action ?? SkillBuildMode.Validate;
  if (action === SkillBuildMode.Evaluate) {
    const goal = params.goal?.trim();
    return goal
      ? { _tag: "valid", mode: { _tag: SkillBuildMode.Evaluate, path: params.path!, goal } }
      : invalidMode("Evaluate mode requires the user's goal.");
  }
  return params.goal
    ? invalidMode("Goal applies only to evaluate mode.")
    : { _tag: "valid", mode: { _tag: SkillBuildMode.Validate, path: params.path! } };
}

function resolveSkillBuildMode(params: SkillBuildParams): SkillBuildModeResolution {
  const creating = Boolean(params.name);
  const existing = Boolean(params.path);
  if (creating && existing) {
    return invalidMode("Provide either name (create) or path (validate or evaluate), not both.");
  }
  if (creating) return resolveCreateMode(params);
  if (existing) return resolveExistingMode(params);
  return invalidMode(
    "Provide name+description+template to create, or path to validate or evaluate.",
  );
}

function operationalFailure(
  operation: SkillBuildOperation,
  message: string,
  _cause: unknown,
): SkillBuildOperationalError {
  return new SkillBuildOperationalError({ operation, message });
}

function validationCounts(validation: ValidationResult): {
  error_count: number;
  warning_count: number;
} {
  return {
    error_count: validation.issues.filter((issue) => issue.severity === "error").length,
    warning_count: validation.issues.filter((issue) => issue.severity === "warning").length,
  };
}

function appendValidationSummary(lines: string[], validation: ValidationResult): void {
  const errorCount = validation.issues.filter((issue) => issue.severity === "error").length;
  const warningCount = validation.issues.filter((issue) => issue.severity === "warning").length;

  lines.push("");
  lines.push(
    validation.valid
      ? "✓ Validate: passed"
      : `✗ Validate: ${errorCount} error(s), ${warningCount} warning(s)`,
  );
  for (const issue of validation.issues) {
    lines.push(
      `  [${issue.severity.toUpperCase()}] ${issue.rule}: ${issue.message}${issue.file ? ` (${issue.file})` : ""}`,
    );
  }
}

function runCreateWorkflowEffect(
  mode: Extract<SkillBuildMode, { _tag: "create" }>,
  options: SkillBuildOptions,
  diagnostics: ToolingDiagnostics,
): Effect.Effect<TextResult, SkillBuildOperationalError> {
  return diagnostics.span(
    SkillBuildSpanName.Workflow,
    { operation: SkillBuildOperation.Run, mode: SkillBuildMode.Create, template: mode.template },
    Effect.gen(function* () {
      const scaffold = yield* diagnostics.span(
        SkillBuildSpanName.Scaffold,
        {
          operation: SkillBuildOperation.Run,
          mode: SkillBuildMode.Create,
          template: mode.template,
        },
        Effect.try({
          try: () =>
            scaffoldSkill({
              name: mode.name,
              description: mode.description,
              template: mode.template,
              targetDir: mode.targetDir ? resolve(options.cwd, mode.targetDir) : undefined,
            }),
          catch: (cause) =>
            operationalFailure(SkillBuildOperation.Scaffold, "Skill scaffold failed", cause),
        }),
      );
      if (!scaffold.success) {
        yield* diagnostics.annotate({
          operation: SkillBuildOperation.Run,
          mode: SkillBuildMode.Create,
          outcome: "failure",
        });
        return textResult(`✗ Scaffold failed: ${scaffold.error}`);
      }

      const validation = yield* diagnostics.span(
        SkillBuildSpanName.Validate,
        { operation: SkillBuildOperation.Run, mode: SkillBuildMode.Create },
        Effect.try({
          try: () => validateSkill(scaffold.skillDir),
          catch: (cause) =>
            operationalFailure(SkillBuildOperation.Validate, "Skill validation failed", cause),
        }),
      );
      yield* diagnostics.annotate({
        operation: SkillBuildOperation.Run,
        mode: SkillBuildMode.Create,
        outcome: validation.valid ? "success" : "failure",
        file_count: scaffold.filesCreated.length,
        ...validationCounts(validation),
      });
      const lines = [
        `✓ Scaffolded "${mode.name}" at ${scaffold.skillDir}`,
        `  Template: ${mode.template}  Files: ${scaffold.filesCreated.join(", ")}`,
      ];
      appendValidationSummary(lines, validation);
      lines.push("");
      lines.push("Next: replace the scaffold placeholders, then validate the skill by path.");
      return textResult(lines.join("\n"), { skillDir: scaffold.skillDir, validation });
    }),
  );
}

const EVALUATOR_SYSTEM_PROMPT = [
  "You are an advisory skill review subagent with no parent conversation context.",
  "The task contains the user goal, skill content, diff, rubric, and exact JSON schema.",
  "Return one JSON object and no other text. Do not use tools or request follow-up work.",
].join("\n");

interface EvaluationSummaryMetadata {
  readonly evaluation?: EvaluationResult;
  readonly findingCount: number;
  readonly errorKind?: string;
}

function configuredModel(ctx: ExtensionContext): any {
  const current = (ctx as ExtensionContext & { model?: unknown }).model;
  if (current) return current;
  const fallback = ctx.modelRegistry.getAvailable()[0];
  if (!fallback) throw new Error("No usable model is available for skill evaluation.");
  return fallback;
}

function modelString(model: any): string | undefined {
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
}

export function modelConfigFromModel(model: any, actualModel?: string): EvalModelConfig {
  return {
    provider: model?.provider || "unknown",
    model: actualModel || model?.id || "unknown",
    costModel: model ? "api" : "self-hosted",
    costPerMillionInputTokens: model?.cost?.input || 0,
    costPerMillionOutputTokens: model?.cost?.output || 0,
  };
}

function toolUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.cost,
    },
  };
}

function appendEvaluationSummary(
  lines: string[],
  result: AgentToolResult<any>,
  skillName: string,
  model: any,
): EvaluationSummaryMetadata {
  lines.push("");
  if (result.details.isError) {
    const reason = result.details.stopReason || "subagent failed";
    lines.push(`Advisory evaluation unavailable for user review (${reason}).`);
    return { findingCount: 0, errorKind: "subagent" };
  }

  const usage = result.details.usage;
  const modelConfig = modelConfigFromModel(model, result.details.model);
  const evaluation = parseEvalResponse(result.details.finalOutput, skillName, modelConfig, {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    actualCost: usage.cost,
  });
  const cost =
    evaluation.tokenEconomy.costModel === "self-hosted"
      ? "self-hosted"
      : `$${evaluation.tokenEconomy.estimatedCost.toFixed(6)}`;
  lines.push(
    `Advisory evaluation: ${evaluation.findings.length} finding(s) for user review (${evaluation.tokenEconomy.provider}/${evaluation.tokenEconomy.model}, ${evaluation.tokenEconomy.inputTokens}in/${evaluation.tokenEconomy.outputTokens}out, ${cost})`,
  );
  for (const finding of evaluation.findings) {
    lines.push(`  [${finding.severity.toUpperCase()}] ${finding.category}: ${finding.message}`);
  }
  if (evaluation.findings.length > 0) {
    lines.push("Review each finding against the user's goal. Do not rerun only to obtain a pass.");
  }
  return { evaluation, findingCount: evaluation.findings.length };
}

function evaluationRun(
  skillName: string,
  prompt: string,
  skillDir: string,
  model: any,
): ResolvedSubagentRun {
  return {
    name: `skill-evaluation-${skillName}`,
    task: prompt,
    tools: [],
    toolNames: [],
    model,
    modelOverride: modelString(model),
    systemPrompt: EVALUATOR_SYSTEM_PROMPT,
    cwd: skillDir,
    workspaceAccess: WorkspaceAccess.Read,
  };
}

function evaluationOptions(options: SkillBuildOptions): RunSubagentOptions {
  return { signal: options.signal, env: options.env };
}

function runExistingSkillWorkflowEffect(
  pi: ExtensionAPI,
  mode: Extract<SkillBuildMode, { _tag: "validate" | "evaluate" }>,
  options: SkillBuildOptions,
  diagnostics: ToolingDiagnostics,
): Effect.Effect<TextResult, SkillBuildOperationalError> {
  return diagnostics.span(
    SkillBuildSpanName.Workflow,
    { operation: SkillBuildOperation.Run, mode: mode._tag },
    Effect.gen(function* () {
      const skillDir = resolve(options.cwd, mode.path);
      const validation = yield* diagnostics.span(
        SkillBuildSpanName.Validate,
        { operation: SkillBuildOperation.Run, mode: mode._tag },
        Effect.try({
          try: () => validateSkill(skillDir),
          catch: (cause) =>
            operationalFailure(SkillBuildOperation.Validate, "Skill validation failed", cause),
        }),
      );
      const lines: string[] = [];
      appendValidationSummary(lines, validation);

      if (mode._tag === SkillBuildMode.Validate || !validation.valid) {
        yield* diagnostics.annotate({
          operation: SkillBuildOperation.Run,
          mode: mode._tag,
          outcome: validation.valid ? "success" : "failure",
          ...validationCounts(validation),
        });
        return textResult(lines.join("\n"), { skillDir, validation });
      }
      if (options.allowEvaluation === false) {
        lines.push("");
        lines.push("Advisory evaluation must run from the parent session.");
        return textResult(lines.join("\n"), { skillDir, validation });
      }
      if (!options.ctx) {
        lines.push("");
        lines.push(
          "Advisory evaluation unavailable for user review: parent session context is missing.",
        );
        return textResult(lines.join("\n"), { skillDir, validation });
      }

      const skillMdPath = join(skillDir, "SKILL.md");
      const skillContent = yield* Effect.try({
        try: () => readFileSync(skillMdPath, "utf-8"),
        catch: (cause) =>
          operationalFailure(SkillBuildOperation.FileRead, "Skill file read failed", cause),
      });
      const skillName = validation.name || basename(skillDir);
      const diff = yield* diagnostics.span(
        SkillBuildSpanName.Diff,
        { operation: SkillBuildOperation.Diff, mode: mode._tag },
        Effect.tryPromise({
          try: (signal) => resolveSkillDiff(pi.exec.bind(pi) as ExecFn, skillDir, signal),
          catch: (cause) =>
            operationalFailure(SkillBuildOperation.Diff, "Skill diff resolution failed", cause),
        }),
      );
      const prompt = buildEvalPrompt(skillContent, skillName, mode.goal, diff.diff);
      const modelResult = yield* Effect.result(
        Effect.try({
          try: () => configuredModel(options.ctx!),
          catch: (cause) =>
            operationalFailure(
              SkillBuildOperation.Evaluate,
              "Skill evaluation model resolution failed",
              cause,
            ),
        }),
      );
      if (Result.isFailure(modelResult)) {
        lines.push("");
        lines.push("Advisory evaluation unavailable for user review: no model is available.");
        yield* diagnostics.annotate({
          operation: SkillBuildOperation.Run,
          mode: mode._tag,
          outcome: "success",
          error_kind: "model",
          ...validationCounts(validation),
        });
        return textResult(lines.join("\n"), {
          skillDir,
          validation,
          diffSource: diff.source,
        });
      }
      const model = modelResult.success;
      const child = yield* Effect.result(
        diagnostics.span(
          SkillBuildSpanName.Evaluate,
          {
            operation: SkillBuildOperation.Run,
            mode: mode._tag,
            provider: model.provider,
            model: model.id,
            cost_model: "subagent",
          },
          evaluationRunner(
            evaluationRun(skillName, prompt, skillDir, model),
            options.ctx,
            evaluationOptions(options),
          ).pipe(
            Effect.mapError((cause) =>
              operationalFailure(SkillBuildOperation.Evaluate, "Skill evaluation failed", cause),
            ),
          ),
        ),
      );
      if (Result.isFailure(child)) {
        lines.push("");
        lines.push("Advisory evaluation unavailable for user review.");
        yield* diagnostics.annotate({
          operation: SkillBuildOperation.Run,
          mode: mode._tag,
          outcome: "success",
          error_kind: "subagent",
          ...validationCounts(validation),
        });
        return textResult(lines.join("\n"), {
          skillDir,
          validation,
          diffSource: diff.source,
        });
      }

      const result = child.success;
      const summary = appendEvaluationSummary(lines, result, skillName, model);
      yield* diagnostics.annotate({
        operation: SkillBuildOperation.Run,
        mode: mode._tag,
        outcome: "success",
        error_kind: summary.errorKind,
        verdict: summary.evaluation?.verdict,
        finding_count: summary.findingCount,
        provider: model.provider,
        model: result.details.model || model.id,
        cost_model: modelConfigFromModel(model).costModel,
        ...validationCounts(validation),
      });
      return textResult(
        lines.join("\n"),
        {
          skillDir,
          validation,
          diffSource: diff.source,
          evaluation: summary.evaluation,
          child: {
            sessionFile: result.details.sessionFile,
            sessionName: result.details.sessionName,
            model: result.details.model,
            usage: result.details.usage,
            isError: result.details.isError,
          },
        },
        toolUsage(result.details.usage),
      );
    }),
  );
}

export function executeSkillBuildEffect(
  pi: ExtensionAPI,
  params: SkillBuildParams,
  options: SkillBuildOptions,
  diagnostics: ToolingDiagnostics = noopToolingDiagnostics,
): Effect.Effect<TextResult, SkillBuildOperationalError> {
  const resolution = resolveSkillBuildMode(params);
  if (resolution._tag === "invalid") return Effect.succeed(textResult(resolution.message));
  return resolution.mode._tag === SkillBuildMode.Create
    ? runCreateWorkflowEffect(resolution.mode, options, diagnostics)
    : runExistingSkillWorkflowEffect(pi, resolution.mode, options, diagnostics);
}

/** Promise compatibility boundary for Pi and AgentTool execute callbacks. */
export function runSkillBuild(
  pi: ExtensionAPI,
  params: SkillBuildParams,
  options: SkillBuildOptions,
): Promise<TextResult> {
  const program = withToolingTelemetryRuntime(
    {
      env: options.env ?? process.env,
      exporter: options.telemetryExporter,
      serviceName: "pi-env-skill-builder",
    },
    (runtime) => executeSkillBuildEffect(pi, params, options, runtime.diagnostics),
  );
  return Effect.runPromise(program, { signal: options.signal });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "reference_skill",
    label: "Reference Skill",
    description: REFERENCE_SKILL_TOOL_DESCRIPTION,
    parameters: REFERENCE_SKILL_PARAMETERS,
    async execute(_toolCallId, params) {
      return executeReferenceSkill(params);
    },
  });

  pi.registerTool({
    name: "skill_build",
    label: "Skill Build",
    description:
      "Create, validate, or evaluate a pi skill. " +
      "Create mode passes name + description + template. " +
      "A path defaults to deterministic validation. " +
      'Pass action "evaluate" with the user goal for one advisory subagent review. ' +
      "Evaluation uses local SKILL.md changes against Git HEAD when available.",
    parameters: SKILL_BUILD_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runSkillBuild(pi, params, {
        cwd: ctx.cwd,
        signal,
        ctx,
      });
    },
  });

  const referenceSkillAgentTool: AgentTool<any, any> = {
    name: "reference_skill",
    label: "Reference Skill",
    description: REFERENCE_SKILL_TOOL_DESCRIPTION,
    parameters: REFERENCE_SKILL_PARAMETERS,
    execute: async (_toolCallId, params) => executeReferenceSkill(params as ReferenceSkillParams),
  };
  const createSkillBuildAgentTool = (
    cwd: string,
    parentContext?: ExtensionContext,
  ): AgentTool<any, any> => ({
    name: "skill_build",
    label: "Skill Build",
    description:
      "Create or validate a pi skill. Advisory evaluation must run from the parent session.",
    parameters: SKILL_BUILD_PARAMETERS,
    execute: async (_toolCallId, params, signal) =>
      runSkillBuild(pi, params as SkillBuildParams, {
        cwd,
        signal,
        ctx: parentContext,
        allowEvaluation: false,
      }),
  });
  registerAgentToolsOnSessionStart(pi, [
    { tool: referenceSkillAgentTool, capabilities: [ToolCapability.Read] },
    {
      tool: createSkillBuildAgentTool(process.cwd()),
      createTool: ({ cwd, parentContext }) => createSkillBuildAgentTool(cwd, parentContext),
      capabilities: [ToolCapability.Read, ToolCapability.Write],
    },
  ]);
}
