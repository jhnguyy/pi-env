/**
 * Skill validator — checks a skill directory against the Agent Skills spec
 * and pi context-efficiency best practices.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join, relative } from "path";
import type { SkillFrontmatter, ValidationIssue, ValidationResult } from "./types";

/** Parse YAML-like frontmatter from a markdown string. Simple key: value parser. */
export function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Handle booleans
    if (value === "true") value = true;
    else if (value === "false") value = false;

    frontmatter[key] = value;
  }

  return { frontmatter: frontmatter as SkillFrontmatter, body };
}

/** Name format: lowercase a-z, 0-9, single hyphens, no leading/trailing hyphens. */
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const CONSECUTIVE_HYPHENS_RE = /--/;

/** Words too vague for a skill description. */
const VAGUE_WORDS = ["stuff", "things", "helps", "does", "misc", "general", "various"];
const MIN_DESCRIPTION_LENGTH = 30;

/** Patterns that look like file references in markdown. */
const FILE_REF_PATTERNS = [
  /\.\/([\w./-]+)/g,           // ./path/to/file
  /\]\(([\w./-]+)\)/g,         // [text](path)
  /`\.\/([\w./-]+)`/g,         // `./path/to/file`
];

/** Extract relative file references from markdown body. */
function extractFileReferences(body: string): string[] {
  const refs = new Set<string>();
  for (const pattern of FILE_REF_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      const ref = match[1];
      if (ref && !ref.startsWith("http") && !ref.startsWith("#")) {
        refs.add(ref);
      }
    }
  }
  return Array.from(refs);
}

export function validateSkill(skillDir: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  let parsed: ReturnType<typeof parseFrontmatter> = null;

  // ─── Directory exists ──────────────────────────────────────────
  if (!existsSync(skillDir)) {
    issues.push({
      rule: "dir-exists",
      severity: "error",
      message: `Skill directory does not exist: ${skillDir}`,
    });
    return { valid: false, issues };
  }

  // ─── SKILL.md exists ──────────────────────────────────────────
  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    issues.push({
      rule: "skill-md-exists",
      severity: "error",
      message: "SKILL.md not found in skill directory.",
      file: "SKILL.md",
    });
    return { valid: false, issues };
  }

  // ─── Parse frontmatter ────────────────────────────────────────
  const content = readFileSync(skillMdPath, "utf-8");
  parsed = parseFrontmatter(content);

  if (!parsed) {
    issues.push({
      rule: "frontmatter-exists",
      severity: "error",
      message: "SKILL.md has no YAML frontmatter (expected --- delimited block).",
      file: "SKILL.md",
    });
    return { valid: false, issues };
  }

  const { frontmatter, body } = parsed;
  const dirName = basename(skillDir);

  // ─── Name validation ──────────────────────────────────────────
  if (frontmatter.name) {
    const name = String(frontmatter.name);

    if (!NAME_RE.test(name) || CONSECUTIVE_HYPHENS_RE.test(name)) {
      issues.push({
        rule: "name-format",
        severity: "error",
        message: `Name "${name}" must be lowercase a-z, 0-9, single hyphens only, no leading/trailing hyphens.`,
        file: "SKILL.md",
      });
    }

    if (name.length > 64) {
      issues.push({
        rule: "name-length",
        severity: "error",
        message: `Name exceeds 64 characters (${name.length}).`,
        file: "SKILL.md",
      });
    }

    if (name !== dirName) {
      issues.push({
        rule: "name-matches-dir",
        severity: "warning",
        message: `Frontmatter name "${name}" doesn't match directory name "${dirName}".`,
        file: "SKILL.md",
      });
    }
  }

  // ─── Description validation ───────────────────────────────────
  if (!frontmatter.description) {
    issues.push({
      rule: "description-exists",
      severity: "error",
      message: "Description is required in frontmatter.",
      file: "SKILL.md",
    });
  } else {
    const desc = String(frontmatter.description);

    if (desc.length > 1024) {
      issues.push({
        rule: "description-length",
        severity: "error",
        message: `Description exceeds 1024 characters (${desc.length}).`,
        file: "SKILL.md",
      });
    }

    // Quality check: too short or contains vague words
    const descLower = desc.toLowerCase();
    const isVague =
      desc.length < MIN_DESCRIPTION_LENGTH ||
      VAGUE_WORDS.some((w) => {
        // Match whole word
        const re = new RegExp(`\\b${w}\\b`, "i");
        return re.test(descLower);
      });

    if (isVague) {
      issues.push({
        rule: "description-quality",
        severity: "warning",
        message:
          "Description is vague. Be specific about what the skill does and when to use it.",
        file: "SKILL.md",
      });
    }
  }

  // ─── Context efficiency ───────────────────────────────────────
  const bodyBytes = Buffer.byteLength(body, "utf-8");

  // No hard size limit — some skills are legitimately large.
  // Surface size as info so the agent can decide whether decomposition makes sense.
  if (bodyBytes > 8192) {
    issues.push({
      rule: "context-size",
      severity: "info",
      message: `SKILL.md body is ${(bodyBytes / 1024).toFixed(1)}KB. Consider: does this skill cover one cohesive concern, or could it decompose into smaller skills? If it's cohesive, the size is fine. If sections are independently useful, splitting reduces per-invocation context cost.`,
      file: "SKILL.md",
    });
  }

  // Check if large body lacks references to external files
  if (bodyBytes > 4096) {
    const refs = extractFileReferences(body);
    // Also check for markdown link references to files
    const hasExternalRefs = refs.length > 0 || /references?\//i.test(body);

    if (!hasExternalRefs) {
      issues.push({
        rule: "context-compression",
        severity: "info",
        message:
          "SKILL.md body exceeds 4KB without referencing external files. Consider using the index pattern: keep SKILL.md as a compressed index and move detailed docs to references/.",
        file: "SKILL.md",
      });
    }
  }

  // ─── Broken references ────────────────────────────────────────
  const refs = extractFileReferences(body);
  for (const ref of refs) {
    const fullPath = join(skillDir, ref);
    if (!existsSync(fullPath)) {
      issues.push({
        rule: "reference-exists",
        severity: "warning",
        message: `Referenced file "${ref}" does not exist.`,
        file: "SKILL.md",
      });
    }
  }

  // ─── Aggregate ────────────────────────────────────────────────
  const hasErrors = issues.some((i) => i.severity === "error");

  return {
    valid: !hasErrors,
    issues,
    name: frontmatter.name ? String(frontmatter.name) : undefined,
  };
}
