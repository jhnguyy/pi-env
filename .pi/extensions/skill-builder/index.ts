/**
 * Skill Builder Extension
 *
 * Provides:
 * - `skill_build` tool — scaffold and validate a new skill, or run validation
 *   plus advisory evaluation for an existing skill
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readFileSync, readdirSync, existsSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { PiEvent, registerAgentTools, ToolCapability } from "../_shared/agent-tools";

const USER_REFERENCE_DIR = join(homedir(), ".agents", "skills", "reference");
const REFERENCE_SKILL_TOOL_DESCRIPTION =
  "Load a named reference skill only when the user explicitly asks to reference that skill (for example: 'reference the teach skill to help me learn X'). Call without a name only when the user asks what reference skills are available.";

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

import { validateSkill } from "./validator";
import { scaffoldSkill, DEFAULT_SKILLS_DIR } from "./scaffolder";
import { buildEvalPrompt, parseEvalResponse, type EvalModelConfig } from "./evaluator";
import type { ValidationResult } from "./types";

type ReferenceSkillParams = { name?: string };
type SkillBuildParams = {
  name?: string;
  description?: string;
  template?: "basic" | "with-scripts" | "with-index";
  targetDir?: string;
  path?: string;
  diff?: string;
};

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

type SkillBuildOptions = {
  cwd: string;
  signal?: AbortSignal;
  modelConfig: EvalModelConfig;
};

const SkillBuildMode = {
  Create: "create",
  Review: "review",
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
      _tag: typeof SkillBuildMode.Review;
      path: string;
      diff?: string;
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
      description: "New skill name. Lowercase a-z, 0-9, hyphens only. Triggers create workflow.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "What the skill does and when to use it. Be specific. Max 1024 chars.",
    }),
  ),
  template: Type.Optional(
    StringEnum(["basic", "with-scripts", "with-index"] as const, {
      description:
        'Use "basic" for concise skills; use "with-index" only when supporting references are necessary.',
    }),
  ),
  targetDir: Type.Optional(
    Type.String({
      description: `Target parent directory for new skill. Default: ${DEFAULT_SKILLS_DIR}`,
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Path to existing skill directory. Triggers review workflow.",
    }),
  ),
  diff: Type.Optional(
    Type.String({
      description: "Unified diff of changes to SKILL.md. Focuses evaluation on what changed.",
    }),
  ),
});

function textResult(text: string, details: unknown = null): TextResult {
  return { content: [{ type: "text", text }], details };
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

function resolveSkillBuildMode(params: SkillBuildParams): SkillBuildModeResolution {
  const creating = Boolean(params.name);
  const reviewing = Boolean(params.path);

  if (!creating && !reviewing) {
    return {
      _tag: "invalid",
      message: "✗ Provide name+description+template to create, or path to review.",
    };
  }
  if (creating && reviewing) {
    return {
      _tag: "invalid",
      message: "✗ Provide either name (create) or path (review), not both.",
    };
  }
  if (creating && (!params.description || !params.template)) {
    return {
      _tag: "invalid",
      message: "✗ Create mode requires name, description, and template.",
    };
  }
  if (creating) {
    return {
      _tag: "valid",
      mode: {
        _tag: SkillBuildMode.Create,
        name: params.name!,
        description: params.description!,
        template: params.template!,
        targetDir: params.targetDir,
      },
    };
  }
  return {
    _tag: "valid",
    mode: {
      _tag: SkillBuildMode.Review,
      path: params.path!,
      diff: params.diff,
    },
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

function runCreateWorkflow(
  mode: Extract<SkillBuildMode, { _tag: "create" }>,
  options: SkillBuildOptions,
): TextResult {
  const scaffold = scaffoldSkill({
    name: mode.name,
    description: mode.description,
    template: mode.template,
    targetDir: mode.targetDir ? resolve(options.cwd, mode.targetDir) : undefined,
  });
  if (!scaffold.success) {
    return textResult(`✗ Scaffold failed: ${scaffold.error}`);
  }

  const validation = validateSkill(scaffold.skillDir);
  const lines = [
    `✓ Scaffolded "${mode.name}" at ${scaffold.skillDir}`,
    `  Template: ${mode.template}  Files: ${scaffold.filesCreated.join(", ")}`,
  ];
  appendValidationSummary(lines, validation);
  lines.push("");
  lines.push("Next: replace the scaffold placeholders, then review the skill by path.");
  return textResult(lines.join("\n"), { skillDir: scaffold.skillDir, validation });
}

function appendEvaluationSummary(
  lines: string[],
  result: { code: number; stdout: string; stderr: string },
  evalPrompt: string,
  skillName: string,
  modelConfig: EvalModelConfig,
): void {
  lines.push("");
  if (result.code !== 0) {
    lines.push(`✗ Evaluate: subagent failed (exit ${result.code}): ${result.stderr.slice(0, 200)}`);
    return;
  }

  const evalResult = parseEvalResponse(result.stdout, skillName, modelConfig, {
    inputTokens: Math.ceil(evalPrompt.length / 4),
    outputTokens: Math.ceil(result.stdout.length / 4),
  });
  const icon =
    evalResult.verdict === "pass" ? "✓" : evalResult.verdict === "needs-revision" ? "△" : "✗";
  const cost =
    evalResult.tokenEconomy.costModel === "self-hosted"
      ? "self-hosted"
      : `$${evalResult.tokenEconomy.estimatedCost.toFixed(6)}`;
  lines.push(
    `${icon} Evaluate: ${evalResult.verdict}  (${evalResult.tokenEconomy.model}, ${evalResult.tokenEconomy.inputTokens}in/${evalResult.tokenEconomy.outputTokens}out, ${cost})`,
  );
  for (const finding of evalResult.findings) {
    lines.push(`  [${finding.severity.toUpperCase()}] ${finding.category}: ${finding.message}`);
  }
}

async function runReviewWorkflow(
  pi: ExtensionAPI,
  mode: Extract<SkillBuildMode, { _tag: "review" }>,
  options: SkillBuildOptions,
): Promise<TextResult> {
  const skillDir = resolve(options.cwd, mode.path);
  const validation = validateSkill(skillDir);
  const lines: string[] = [];
  appendValidationSummary(lines, validation);

  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    return textResult(lines.join("\n"), { skillDir, validation });
  }

  const skillContent = readFileSync(skillMdPath, "utf-8");
  const skillName = skillContent.match(/^name:\s*(.+)$/m)?.[1]?.trim() || basename(skillDir);
  const evalPrompt = buildEvalPrompt(skillContent, skillName, mode.diff);
  const result = await pi.exec(
    "pi",
    ["-p", "--no-session", "--no-skills", "--no-extensions", "--tools", "", evalPrompt],
    { signal: options.signal, timeout: 60000 },
  );
  appendEvaluationSummary(lines, result, evalPrompt, skillName, options.modelConfig);
  return textResult(lines.join("\n"), { skillDir, validation });
}

async function executeSkillBuild(
  pi: ExtensionAPI,
  params: SkillBuildParams,
  options: SkillBuildOptions,
): Promise<TextResult> {
  const resolution = resolveSkillBuildMode(params);
  if (resolution._tag === "invalid") return textResult(resolution.message);
  return resolution.mode._tag === SkillBuildMode.Create
    ? runCreateWorkflow(resolution.mode, options)
    : runReviewWorkflow(pi, resolution.mode, options);
}

function modelConfigFromContext(model: any): EvalModelConfig {
  return {
    provider: model?.provider || "unknown",
    model: model?.id || "unknown",
    costModel: model ? "api" : "self-hosted",
    costPerInputToken: model?.cost?.input || 0,
    costPerOutputToken: model?.cost?.output || 0,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "reference_skill",
    label: "Reference Skill",
    description: REFERENCE_SKILL_TOOL_DESCRIPTION,
    parameters: REFERENCE_SKILL_PARAMETERS,
    async execute(_toolCallId, params) {
      return executeReferenceSkill(params as ReferenceSkillParams);
    },
  });

  pi.registerTool({
    name: "skill_build",
    label: "Skill Build",
    description:
      "Create or review a pi skill. " +
      "Create mode (pass name + description + template): scaffold → validate. " +
      "Review mode (pass path): validate → advisory evaluation. " +
      "Pass diff to focus evaluation on what changed.",
    parameters: SKILL_BUILD_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeSkillBuild(pi, params as SkillBuildParams, {
        cwd: ctx.cwd,
        signal,
        modelConfig: modelConfigFromContext(ctx.model),
      });
    },
  });

  pi.on(PiEvent.SessionStart, () => {
    const referenceSkillAgentTool: AgentTool<any, any> = {
      name: "reference_skill",
      label: "Reference Skill",
      description: REFERENCE_SKILL_TOOL_DESCRIPTION,
      parameters: REFERENCE_SKILL_PARAMETERS,
      execute: async (_toolCallId, params) => executeReferenceSkill(params as ReferenceSkillParams),
    };

    const skillBuildAgentTool: AgentTool<any, any> = {
      name: "skill_build",
      label: "Skill Build",
      description:
        "Create or review a pi skill. Create mode scaffolds and validates; review mode validates and runs advisory evaluation.",
      parameters: SKILL_BUILD_PARAMETERS,
      execute: async (_toolCallId, params, signal) =>
        executeSkillBuild(pi, params as SkillBuildParams, {
          cwd: process.cwd(),
          signal,
          modelConfig: modelConfigFromContext(null),
        }),
    };

    registerAgentTools(pi, [
      { tool: referenceSkillAgentTool, capabilities: [ToolCapability.Read] },
      {
        tool: skillBuildAgentTool,
        capabilities: [ToolCapability.Read, ToolCapability.Write, ToolCapability.Execute],
      },
    ]);
  });
}
