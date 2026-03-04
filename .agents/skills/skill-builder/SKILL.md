---
name: skill-builder
description: Build, validate, and evaluate pi skills following Agent Skills spec and context engineering best practices. Use when creating new skills, reviewing existing skills, or validating skill quality.
---

# Skill Builder

## Conventions

**Reference skills** — some skills are manually loaded, not auto-discovered. They live in `~/.agents/skills/reference/` as plain `.md` files. Before scaffolding, confirm whether the skill should be a reference skill or a full auto-discovered skill. Current reference skills: `handoff`, `distillation`, `index-generator`.

**Auto-discovered skills** — directories with `SKILL.md` in `~/.agents/skills/` (global) or `.pi/skills/` (project). Names: lowercase, a-z, 0-9, single hyphens, 1–64 chars, must match directory name.

## Building a New Skill

### 1. Choose a Template

| Template | When to Use |
|---|---|
| `with-index` | **Default choice.** Large domains, or anything with significant supporting detail. SKILL.md stays as a compressed map; detailed docs live in `references/`. |
| `with-scripts` | Skills that need executable helpers. |
| `basic` | Self-contained skills where everything fits in one file. |

### 2. Create

```
skill_build({ name: "...", description: "...", template: "with-index" })
```

Runs the full pipeline: scaffold → validate → evaluate. Returns combined result.

Description must be specific and actionable: "Extracts text from PDFs and fills forms" not "Helps with PDFs".

### 3. Write instructions, then review

```
skill_build({ path: "/path/to/skill-dir" })
```

Runs validate → evaluate. Returns combined result. Fix errors first, then warnings.

Pass `diff` to focus evaluation on what changed:

```
skill_build({ path: "...", diff: "<unified diff>" })
```

**Context engineering principles:**

- **Index > embed.** Keep SKILL.md as a compressed navigational map. Move detailed docs to `references/`.
- **Progressive disclosure.** Description loads by default. Full SKILL.md loads on-demand. Reference files load only when needed. Each layer must justify its token cost.
- **Finite instruction budget.** Every directive competes with the system prompt and AGENTS.md. Prefer fewer, more precise instructions over comprehensive coverage.
- **Retrieval-led > pre-training-led.** For domains with evolving specs or APIs, include the instruction to prefer retrieval over memory.

## After Editing Extension Files

If the skill has a backing extension and you edited files under `~/.pi/agent/extensions/<ext-name>/`, run jit-catch before declaring done:

```
jit_catch({ diff_source: "unstaged" })
```
