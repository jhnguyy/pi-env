/**
 * Skill Builder Extension
 *
 * Provides:
 * - `skill_build` tool — create (scaffold → validate → evaluate) or
 *   review (validate → evaluate) a pi skill in one call
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
      description: '"with-index" recommended — compressed index pattern for context efficiency.',
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
    return textResult(
      `No reference skill directories found. Checked: ${USER_REFERENCE_DIR}`,
      { referenceDirs },
    );
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
    return textResult(`No reference skill named "${params.name}". Available: ${names.join(", ")}`, { referenceDirs });
  }

  return textResult(readFileSync(matched.filePath, "utf-8"), matched);
}

async function executeSkillBuild(
  pi: ExtensionAPI,
  params: SkillBuildParams,
  options: {
    cwd: string;
    signal?: AbortSignal;
    modelConfig: EvalModelConfig;
  },
): Promise<TextResult> {
  const creating = !!params.name;
  const reviewing = !!params.path;

  if (!creating && !reviewing) {
    return textResult("✗ Provide name+description+template to create, or path to review.");
  }
  if (creating && reviewing) {
    return textResult("✗ Provide either name (create) or path (review), not both.");
  }

  const lines: string[] = [];
  let skillDir: string;

  if (creating) {
    if (!params.name || !params.description || !params.template) {
      return textResult("✗ Create mode requires name, description, and template.");
    }

    const scaffold = scaffoldSkill({
      name: params.name,
      description: params.description,
      template: params.template,
      targetDir: params.targetDir ? resolve(options.cwd, params.targetDir) : undefined,
    });

    if (!scaffold.success) {
      return textResult(`✗ Scaffold failed: ${scaffold.error}`);
    }

    skillDir = scaffold.skillDir;
    lines.push(`✓ Scaffolded "${params.name}" at ${scaffold.skillDir}`);
    lines.push(`  Template: ${params.template}  Files: ${scaffold.filesCreated.join(", ")}`);
  } else {
    skillDir = resolve(options.cwd, params.path!);
  }

  const validation = validateSkill(skillDir);
  const errCount = validation.issues.filter((i) => i.severity === "error").length;
  const warnCount = validation.issues.filter((i) => i.severity === "warning").length;

  lines.push("");
  lines.push(
    validation.valid
      ? "✓ Validate: passed"
      : `✗ Validate: ${errCount} error(s), ${warnCount} warning(s)`,
  );
  for (const issue of validation.issues) {
    lines.push(
      `  [${issue.severity.toUpperCase()}] ${issue.rule}: ${issue.message}${issue.file ? ` (${issue.file})` : ""}`,
    );
  }

  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    return textResult(lines.join("\n"), { skillDir, validation });
  }

  const skillContent = readFileSync(skillMdPath, "utf-8");
  const skillName = skillContent.match(/^name:\s*(.+)$/m)?.[1]?.trim() || params.name || basename(skillDir);
  const evalPrompt = buildEvalPrompt(skillContent, skillName, params.diff);
  const result = await pi.exec(
    "pi",
    ["-p", "--no-session", "--no-skills", "--no-extensions", "--tools", "", evalPrompt],
    { signal: options.signal, timeout: 60000 },
  );

  lines.push("");
  if (result.code !== 0) {
    lines.push(`✗ Evaluate: subagent failed (exit ${result.code}): ${result.stderr.slice(0, 200)}`);
  } else {
    const inputTokens = Math.ceil(evalPrompt.length / 4);
    const outputTokens = Math.ceil(result.stdout.length / 4);
    const evalResult = parseEvalResponse(result.stdout, skillName, options.modelConfig, {
      inputTokens,
      outputTokens,
    });
    const icon = evalResult.verdict === "pass" ? "✓" : evalResult.verdict === "needs-revision" ? "△" : "✗";
    const costStr = evalResult.tokenEconomy.costModel === "self-hosted"
      ? "self-hosted"
      : `$${evalResult.tokenEconomy.estimatedCost.toFixed(6)}`;

    lines.push(
      `${icon} Evaluate: ${evalResult.verdict}  (${evalResult.tokenEconomy.model}, ${evalResult.tokenEconomy.inputTokens}in/${evalResult.tokenEconomy.outputTokens}out, ${costStr})`,
    );
    for (const f of evalResult.findings) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.category}: ${f.message}`);
    }
  }

  return textResult(lines.join("\n"), { skillDir, validation });
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
      "Create mode (pass name + description + template): scaffold → validate → evaluate. " +
      "Review mode (pass path): validate → evaluate. " +
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
      description: "Create or review a pi skill. Create mode: scaffold → validate → evaluate. Review mode: validate → evaluate.",
      parameters: SKILL_BUILD_PARAMETERS,
      execute: async (_toolCallId, params, signal) => executeSkillBuild(pi, params as SkillBuildParams, {
        cwd: process.cwd(),
        signal,
        modelConfig: modelConfigFromContext(null),
      }),
    };

    registerAgentTools(pi, [
      { tool: referenceSkillAgentTool, capabilities: [ToolCapability.Read] },
      { tool: skillBuildAgentTool, capabilities: [ToolCapability.Read, ToolCapability.Write, ToolCapability.Execute] },
    ]);
  });
}
