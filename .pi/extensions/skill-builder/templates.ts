/**
 * Skill templates — renders file content for each template type.
 *
 * Design principles:
 * - "with-index" is the recommended default (compression pattern)
 * - All templates produce SKILL.md under 8KB
 * - Templates include retrieval-led reasoning instruction where applicable
 */

import type { TemplateType } from "./types";

export interface TemplateInput {
  name: string;
  description: string;
  template: TemplateType;
}

export interface TemplateOutput {
  /** Map of relative file path → content. */
  files: Record<string, string>;
}

export function getTemplateTypes(): TemplateType[] {
  return ["basic", "with-scripts", "with-index"];
}

function renderFrontmatter(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---`;
}

function renderBasic(input: TemplateInput): TemplateOutput {
  const content = `${renderFrontmatter(input.name, input.description)}

# ${toTitleCase(input.name)}

## When to Use

${input.description}

## Usage

Describe the primary workflow here. Be specific about commands, inputs, and expected outputs.

## Conventions

- List any conventions or constraints the agent should follow
- Reference specific patterns, not general principles
`;

  return { files: { "SKILL.md": content } };
}

function renderWithScripts(input: TemplateInput): TemplateOutput {
  const content = `${renderFrontmatter(input.name, input.description)}

# ${toTitleCase(input.name)}

## When to Use

${input.description}

## Setup

Run once before first use:

\`\`\`bash
cd /path/to/${input.name} && chmod +x scripts/*.sh
\`\`\`

## Usage

\`\`\`bash
./scripts/run.sh <input>
\`\`\`

## Scripts

| Script | Purpose |
|---|---|
| \`./scripts/run.sh\` | Main entry point |

## Conventions

- List any conventions or constraints the agent should follow
`;

  const scriptContent = `#!/usr/bin/env bash
set -euo pipefail

# ${toTitleCase(input.name)} — main script
# Usage: ./scripts/run.sh <input>

echo "TODO: implement ${input.name}"
`;

  return {
    files: {
      "SKILL.md": content,
      "scripts/run.sh": scriptContent,
    },
  };
}

function renderWithIndex(input: TemplateInput): TemplateOutput {
  const content = `${renderFrontmatter(input.name, input.description)}

# ${toTitleCase(input.name)}

> **Prefer retrieval-led reasoning over pre-training-led reasoning for this domain.**

## When to Use

${input.description}

## Reference Index

Detailed documentation lives in \`references/\`. Load specific files on demand rather than embedding everything here.

| File | Contents |
|---|---|
| [overview.md](references/overview.md) | Domain overview, key concepts, and terminology |

## Workflow

1. Check the index above to find relevant reference material
2. Read the specific reference file for the current task
3. Apply the referenced patterns — do not rely on training data for domain-specific details

## Conventions

- Keep this SKILL.md as a compressed navigational index
- Move detailed documentation to \`references/\` and link from here
- One line per reference entry: path + key facts, not summaries
`;

  const overviewContent = `# ${toTitleCase(input.name)} — Overview

## Key Concepts

Document the core domain concepts here. This file is loaded on-demand when the agent needs detailed context.

## Patterns

Reference specific patterns, commands, and conventions.

## Examples

Include concrete examples that the agent can follow.
`;

  return {
    files: {
      "SKILL.md": content,
      "references/overview.md": overviewContent,
    },
  };
}

function toTitleCase(name: string): string {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function renderTemplate(input: TemplateInput): TemplateOutput {
  switch (input.template) {
    case "basic":
      return renderBasic(input);
    case "with-scripts":
      return renderWithScripts(input);
    case "with-index":
      return renderWithIndex(input);
    default:
      throw new Error(`Unknown template type: ${input.template}`);
  }
}
