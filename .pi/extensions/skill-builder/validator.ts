import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";

import type { ValidationIssue, ValidationResult } from "./types";

const FILE_REF_PATTERNS = [/\.\/([\w./-]+)/g, /\]\(([^)]+)\)/g];

function extractFileReferences(body: string): string[] {
  const refs = new Set<string>();
  for (const pattern of FILE_REF_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      let ref = match[1]?.trim();
      if (!ref) continue;
      if (ref.startsWith("<") && ref.endsWith(">")) ref = ref.slice(1, -1);
      ref = ref.split(/[?#]/, 1)[0] ?? "";
      if (!ref || ref.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) {
        continue;
      }
      refs.add(ref);
    }
  }
  return [...refs];
}

function validateReferences(skillDir: string, body: string, issues: ValidationIssue[]): void {
  const root = resolve(skillDir);
  for (const ref of extractFileReferences(body)) {
    const target = resolve(root, ref);
    const relativeTarget = relative(root, target);
    if (isAbsolute(ref) || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
      issues.push({
        rule: "reference-scope",
        severity: "error",
        message: `Referenced file "${ref}" resolves outside the skill directory.`,
        file: "SKILL.md",
      });
      continue;
    }
    if (existsSync(target)) continue;
    issues.push({
      rule: "reference-exists",
      severity: "warning",
      message: `Referenced file "${ref}" does not exist.`,
      file: "SKILL.md",
    });
  }
}

export function validateSkill(skillDir: string): ValidationResult {
  if (!existsSync(skillDir)) {
    return {
      valid: false,
      issues: [
        {
          rule: "dir-exists",
          severity: "error",
          message: `Skill directory does not exist: ${skillDir}`,
        },
      ],
      nativeDiagnostics: [],
    };
  }

  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    return {
      valid: false,
      issues: [
        {
          rule: "skill-md-exists",
          severity: "error",
          message: "SKILL.md not found in skill directory.",
          file: "SKILL.md",
        },
      ],
      nativeDiagnostics: [],
    };
  }

  const native = loadSkills({
    cwd: skillDir,
    agentDir: skillDir,
    skillPaths: [skillMdPath],
    includeDefaults: false,
  });
  const skill = native.skills.length === 1 ? native.skills[0] : undefined;
  const issues: ValidationIssue[] = [];

  if (skill) {
    const content = readFileSync(skillMdPath, "utf-8");
    validateReferences(skillDir, parseFrontmatter(content).body, issues);
  }

  return {
    valid: Boolean(skill) && !issues.some((issue) => issue.severity === "error"),
    issues,
    nativeDiagnostics: native.diagnostics,
    name: skill?.name,
  };
}
