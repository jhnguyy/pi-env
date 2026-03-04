/**
 * Skill scaffolder — creates skill directories from templates.
 *
 * Safety: refuses to overwrite existing directories.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { ScaffoldOptions, ScaffoldResult } from "./types";
import { renderTemplate } from "./templates";

export const DEFAULT_SKILLS_DIR = join(homedir(), ".pi", "agent", "skills");

export function scaffoldSkill(options: ScaffoldOptions): ScaffoldResult {
  const targetDir = options.targetDir ?? DEFAULT_SKILLS_DIR;
  const skillDir = join(targetDir, options.name);

  // Safety: don't overwrite
  if (existsSync(skillDir)) {
    return {
      success: false,
      skillDir,
      filesCreated: [],
      error: `Directory already exists: ${skillDir}`,
    };
  }

  const rendered = renderTemplate({
    name: options.name,
    description: options.description,
    template: options.template,
  });

  const filesCreated: string[] = [];

  for (const [relativePath, content] of Object.entries(rendered.files)) {
    const fullPath = join(skillDir, relativePath);
    const dir = dirname(fullPath);

    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    filesCreated.push(relativePath);
  }

  return {
    success: true,
    skillDir,
    filesCreated,
  };
}
