import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

import type { SkillFrontmatter, ValidationIssue, ValidationResult } from "./types";

const FILE_REF_PATTERNS = [/\.\/([\w./-]+)/g, /\]\(([^)]+)\)/g];

function addIssue(issues: ValidationIssue[], issue: ValidationIssue): void {
  if (issues.some((current) => current.rule === issue.rule)) return;
  issues.push(issue);
}

function hasFrontmatter(content: string): boolean {
  const normalized = content.replace(/\r\n?/g, "\n");
  return normalized.startsWith("---\n") && normalized.indexOf("\n---", 4) >= 0;
}

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

function validateRequiredFields(
  frontmatter: SkillFrontmatter,
  issues: ValidationIssue[],
): { name?: string; fieldsHaveValidTypes: boolean } {
  let fieldsHaveValidTypes = true;
  const name = frontmatter.name;
  if (name === undefined || name === null || name === "") {
    addIssue(issues, {
      rule: "name-exists",
      severity: "error",
      message: "Name is required in frontmatter.",
      file: "SKILL.md",
    });
  } else if (typeof name !== "string") {
    fieldsHaveValidTypes = false;
    addIssue(issues, {
      rule: "name-type",
      severity: "error",
      message: "Name must be a string.",
      file: "SKILL.md",
    });
  }

  const description = frontmatter.description;
  if (description === undefined || description === null || description === "") {
    addIssue(issues, {
      rule: "description-exists",
      severity: "error",
      message: "Description is required in frontmatter.",
      file: "SKILL.md",
    });
  } else if (typeof description !== "string") {
    fieldsHaveValidTypes = false;
    addIssue(issues, {
      rule: "description-type",
      severity: "error",
      message: "Description must be a string.",
      file: "SKILL.md",
    });
  }

  return {
    name: typeof name === "string" && name.length > 0 ? name : undefined,
    fieldsHaveValidTypes,
  };
}

function loaderRule(message: string): string {
  if (message.startsWith("name exceeds")) return "name-length";
  if (message.startsWith("name ")) return "name-format";
  if (message.startsWith("description exceeds")) return "description-length";
  if (message === "description is required") return "description-exists";
  return "frontmatter-parse";
}

function appendLoaderDiagnostics(skillDir: string, issues: ValidationIssue[]): void {
  const result = loadSkillsFromDir({ dir: skillDir, source: "path" });
  for (const diagnostic of result.diagnostics) {
    const rule = loaderRule(diagnostic.message);
    addIssue(issues, {
      rule,
      severity: "error",
      message: diagnostic.message,
      file: "SKILL.md",
    });
  }
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
  const issues: ValidationIssue[] = [];
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
    };
  }

  const content = readFileSync(skillMdPath, "utf-8");
  if (!hasFrontmatter(content)) {
    return {
      valid: false,
      issues: [
        {
          rule: "frontmatter-exists",
          severity: "error",
          message: "SKILL.md has no YAML frontmatter.",
          file: "SKILL.md",
        },
      ],
    };
  }

  let parsed: ReturnType<typeof parseFrontmatter<SkillFrontmatter>>;
  try {
    parsed = parseFrontmatter<SkillFrontmatter>(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : "YAML parsing failed.";
    return {
      valid: false,
      issues: [{ rule: "frontmatter-parse", severity: "error", message, file: "SKILL.md" }],
    };
  }

  const required = validateRequiredFields(parsed.frontmatter, issues);
  if (required.fieldsHaveValidTypes) appendLoaderDiagnostics(skillDir, issues);
  validateReferences(skillDir, parsed.body, issues);

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    name: required.name,
  };
}
