/**
 * Skill Builder Extension
 *
 * Provides:
 * - `skill_build` tool — create (scaffold → validate → evaluate) or
 *   review (validate → evaluate) a pi skill in one call
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readFileSync, readdirSync, existsSync } from "fs";
import { basename, join, resolve } from "path";
import { homedir } from "os";
import type { ExtToolRegistration } from "../subagent/types";

const REFERENCE_DIR = join(homedir(), ".agents", "skills", "reference");

import { validateSkill } from "./validator";
import { scaffoldSkill, DEFAULT_SKILLS_DIR } from "./scaffolder";
import { buildEvalPrompt, parseEvalResponse, type EvalModelConfig } from "./evaluator";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "reference_skill",
    label: "Reference Skill",
    description:
      "Access skills that are not in passive context. Call without a name to list available skills, or with a name to load that skill's instructions.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Skill name to load. Omit to list available skills." }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!existsSync(REFERENCE_DIR)) {
        return {
          content: [{ type: "text", text: `Reference skill directory not found: ${REFERENCE_DIR}` }],
          details: null,
        };
      }

      const files = readdirSync(REFERENCE_DIR).filter((f: string) => f.endsWith(".md"));

      // List mode
      if (!params.name) {
        const names = files.map((f: string) => f.replace(/\.md$/, ""));
        return {
          content: [
            {
              type: "text",
              text: `Available reference skills:\n${names.map((n: string) => `  - ${n}`).join("\n")}`,
            },
          ],
          details: null,
        };
      }

      // Load mode — fuzzy match on filename or frontmatter name
      const target = params.name.toLowerCase();
      let matched: string | null = null;

      for (const file of files) {
        const filePath = join(REFERENCE_DIR, file);
        const content = readFileSync(filePath, "utf-8");
        const nameMatch = content.match(/^---[\s\S]*?^name:\s*(.+?)\s*$/m);
        const skillName = nameMatch ? nameMatch[1].trim().toLowerCase() : file.replace(/\.md$/, "");

        if (skillName === target || file.replace(/\.md$/, "").toLowerCase() === target) {
          matched = filePath;
          break;
        }
      }

      if (!matched) {
        const names = files.map((f: string) => f.replace(/\.md$/, ""));
        return {
          content: [
            {
              type: "text",
              text: `No reference skill named "${params.name}". Available: ${names.join(", ")}`,
            },
          ],
          details: null,
        };
      }

      const content = readFileSync(matched, "utf-8");
      return {
        content: [{ type: "text", text: content }],
        details: null,
      };
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
    parameters: Type.Object({
      // ── Create mode ───────────────────────────────────────────
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
      // ── Review mode ───────────────────────────────────────────
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
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const creating = !!params.name;
      const reviewing = !!params.path;

      // ── Mode validation ──────────────────────────────────────
      if (!creating && !reviewing) {
        return {
          content: [{ type: "text", text: "✗ Provide name+description+template to create, or path to review." }],
          details: null,
        };
      }
      if (creating && reviewing) {
        return {
          content: [{ type: "text", text: "✗ Provide either name (create) or path (review), not both." }],
          details: null,
        };
      }

      const lines: string[] = [];
      let skillDir: string;

      // ── Scaffold (create mode) ───────────────────────────────
      if (creating) {
        if (!params.description || !params.template) {
          return {
            content: [{ type: "text", text: "✗ Create mode requires name, description, and template." }],
            details: null,
          };
        }

        const scaffold = scaffoldSkill({
          name: params.name!,
          description: params.description,
          template: params.template,
          targetDir: params.targetDir ? resolve(ctx.cwd, params.targetDir) : undefined,
        });

        if (!scaffold.success) {
          return {
            content: [{ type: "text", text: `✗ Scaffold failed: ${scaffold.error}` }],
            details: null,
          };
        }

        skillDir = scaffold.skillDir;
        lines.push(`✓ Scaffolded "${params.name}" at ${scaffold.skillDir}`);
        lines.push(`  Template: ${params.template}  Files: ${scaffold.filesCreated.join(", ")}`);
      } else {
        skillDir = resolve(ctx.cwd, params.path!);
      }

      // ── Validate ─────────────────────────────────────────────
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

      // ── Evaluate ─────────────────────────────────────────────
      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { skillDir, validation },
        };
      }

      const skillContent = readFileSync(skillMdPath, "utf-8");
      const skillName =
        skillContent.match(/^name:\s*(.+)$/m)?.[1]?.trim() ||
        params.name ||
        basename(skillDir);

      const evalPrompt = buildEvalPrompt(skillContent, skillName, params.diff);

      const model = ctx.model;
      const modelConfig: EvalModelConfig = {
        provider: model?.provider || "unknown",
        model: model?.id || "unknown",
        costModel: "api",
        costPerInputToken: model?.cost?.input || 0,
        costPerOutputToken: model?.cost?.output || 0,
      };

      const result = await pi.exec(
        "pi",
        ["-p", "--no-session", "--no-skills", "--no-extensions", "--tools", "", evalPrompt],
        { signal, timeout: 60000 },
      );

      lines.push("");
      if (result.code !== 0) {
        lines.push(`✗ Evaluate: subagent failed (exit ${result.code}): ${result.stderr.slice(0, 200)}`);
      } else {
        const inputTokens = Math.ceil(evalPrompt.length / 4);
        const outputTokens = Math.ceil(result.stdout.length / 4);
        const evalResult = parseEvalResponse(result.stdout, skillName, modelConfig, {
          inputTokens,
          outputTokens,
        });

        const icon =
          evalResult.verdict === "pass" ? "✓" : evalResult.verdict === "needs-revision" ? "△" : "✗";
        const costStr =
          evalResult.tokenEconomy.costModel === "self-hosted"
            ? "self-hosted"
            : `$${evalResult.tokenEconomy.estimatedCost.toFixed(6)}`;

        lines.push(
          `${icon} Evaluate: ${evalResult.verdict}  (${evalResult.tokenEconomy.model}, ${evalResult.tokenEconomy.inputTokens}in/${evalResult.tokenEconomy.outputTokens}out, ${costStr})`,
        );
        for (const f of evalResult.findings) {
          lines.push(`  [${f.severity.toUpperCase()}] ${f.category}: ${f.message}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { skillDir, validation },
      };
    },
  });

  // ─── Agent tool registration ──────────────────────────────────────────────────
  pi.on("session_start", () => {
    const referenceSkillAgentTool: AgentTool<any, any> = {
      name: "reference_skill",
      label: "Reference Skill",
      description: "Access skills that are not in passive context. Call without a name to list, or with a name to load.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "Skill name to load. Omit to list available skills." })),
      }),
      execute: async (_toolCallId, params) => {
        if (!existsSync(REFERENCE_DIR)) return { content: [{ type: "text", text: `Reference skill directory not found: ${REFERENCE_DIR}` }], details: null };
        const files = readdirSync(REFERENCE_DIR).filter((f: string) => f.endsWith(".md"));
        if (!params.name) {
          const names = files.map((f: string) => f.replace(/\.md$/, ""));
          return { content: [{ type: "text", text: `Available reference skills:\n${names.map((n: string) => `  - ${n}`).join("\n")}` }], details: null };
        }
        const target = params.name.toLowerCase();
        let matched: string | null = null;
        for (const file of files) {
          const fp = join(REFERENCE_DIR, file);
          const content = readFileSync(fp, "utf-8");
          const nameMatch = content.match(/^---[\s\S]*?^name:\s*(.+?)\s*$/m);
          const skillName = nameMatch ? nameMatch[1].trim().toLowerCase() : file.replace(/\.md$/, "");
          if (skillName === target || file.replace(/\.md$/, "").toLowerCase() === target) { matched = fp; break; }
        }
        if (!matched) return { content: [{ type: "text", text: `No reference skill named "${params.name}".` }], details: null };
        return { content: [{ type: "text", text: readFileSync(matched, "utf-8") }], details: null };
      },
    };
    pi.events.emit("agent-tools:register", { tool: referenceSkillAgentTool, capabilities: ["read"] } satisfies ExtToolRegistration);

    const skillBuildAgentTool: AgentTool<any, any> = {
      name: "skill_build",
      label: "Skill Build",
      description: "Create or review a pi skill. Create mode: scaffold → validate → evaluate. Review mode: validate → evaluate.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "New skill name. Triggers create workflow." })),
        description: Type.Optional(Type.String({ description: "What the skill does and when to use it." })),
        template: Type.Optional(StringEnum(["basic", "with-scripts", "with-index"] as const, { description: "Skill template." })),
        targetDir: Type.Optional(Type.String({ description: `Target parent directory. Default: ${DEFAULT_SKILLS_DIR}` })),
        path: Type.Optional(Type.String({ description: "Path to existing skill directory. Triggers review workflow." })),
        diff: Type.Optional(Type.String({ description: "Unified diff to focus evaluation on." })),
      }),
      execute: async (_toolCallId, params, signal) => {
        const cwd = process.cwd();
        const creating = !!params.name;
        const reviewing = !!params.path;
        if (!creating && !reviewing) return { content: [{ type: "text", text: "✗ Provide name+description+template to create, or path to review." }], details: null };
        if (creating && reviewing) return { content: [{ type: "text", text: "✗ Provide either name (create) or path (review), not both." }], details: null };
        const lines: string[] = [];
        let skillDir: string;
        if (creating) {
          if (!params.description || !params.template) return { content: [{ type: "text", text: "✗ Create mode requires name, description, and template." }], details: null };
          const scaffold = scaffoldSkill({ name: params.name!, description: params.description, template: params.template, targetDir: params.targetDir ? resolve(cwd, params.targetDir) : undefined });
          if (!scaffold.success) return { content: [{ type: "text", text: `✗ Scaffold failed: ${scaffold.error}` }], details: null };
          skillDir = scaffold.skillDir;
          lines.push(`✓ Scaffolded "${params.name}" at ${scaffold.skillDir}`);
        } else {
          skillDir = resolve(cwd, params.path!);
        }
        const validation = validateSkill(skillDir);
        const errCount = validation.issues.filter((i: any) => i.severity === "error").length;
        const warnCount = validation.issues.filter((i: any) => i.severity === "warning").length;
        lines.push(validation.valid ? "✓ Validate: passed" : `✗ Validate: ${errCount} error(s), ${warnCount} warning(s)`);
        for (const issue of validation.issues) lines.push(`  [${(issue as any).severity.toUpperCase()}] ${(issue as any).rule}: ${(issue as any).message}`);
        const skillMdPath = join(skillDir, "SKILL.md");
        if (!existsSync(skillMdPath)) return { content: [{ type: "text", text: lines.join("\n") }], details: { skillDir, validation } };
        const skillContent = readFileSync(skillMdPath, "utf-8");
        const skillName = skillContent.match(/^name:\s*(.+)$/m)?.[1]?.trim() || params.name || basename(skillDir);
        const evalPrompt = buildEvalPrompt(skillContent, skillName, params.diff);
        const result = await pi.exec("pi", ["-p", "--no-session", "--no-skills", "--no-extensions", "--tools", "", evalPrompt], { signal, timeout: 60000 });
        lines.push("");
        if (result.code !== 0) {
          lines.push(`✗ Evaluate: failed (exit ${result.code}): ${result.stderr.slice(0, 200)}`);
        } else {
          const evalResult = parseEvalResponse(result.stdout, skillName, { provider: "unknown", model: "unknown", costModel: "self-hosted", costPerInputToken: 0, costPerOutputToken: 0 }, { inputTokens: Math.ceil(evalPrompt.length / 4), outputTokens: Math.ceil(result.stdout.length / 4) });
          const icon = evalResult.verdict === "pass" ? "✓" : evalResult.verdict === "needs-revision" ? "△" : "✗";
          lines.push(`${icon} Evaluate: ${evalResult.verdict}`);
          for (const f of evalResult.findings) lines.push(`  [${f.severity.toUpperCase()}] ${f.category}: ${f.message}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { skillDir, validation } };
      },
    };
    pi.events.emit("agent-tools:register", { tool: skillBuildAgentTool, capabilities: ["read", "write", "execute"] } satisfies ExtToolRegistration);
  });
}
