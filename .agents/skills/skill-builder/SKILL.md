---
name: skill-builder
description: Build, validate, and evaluate pi skills following Agent Skills spec and context engineering best practices. Use when creating new skills, reviewing existing skills, or validating skill quality.
---

# Skill Builder

## Conventions

**Reference skills** — lightweight skills that live in `~/.agents/skills/reference/` or a package-root `.agents/skills/reference/` directory as plain `.md` files. They are loaded only when explicitly referenced, not through passive skill context.

**Auto-discovered skills** — directories with `SKILL.md` in `~/.agents/skills/` (global) or `.pi/skills/` (project). Names: lowercase, a-z, 0-9, single hyphens, 1–64 chars, must match directory name.

## Building a New Skill

### 1. Choose a Template

| Template | When to Use |
|---|---|
| `basic` | Default when the complete durable method is short. |
| `with-index` | Use only when necessary supporting detail is stable and worth retrieving separately. |
| `with-scripts` | Use when executable helpers are part of the capability. |

### 2. Create

```
skill_build({ name: "...", description: "...", template: "with-index" })
```

Scaffolds and validates the structure. Replace the placeholders with the smallest sufficient method, then review the finished skill by path.

Description must be specific and actionable: "Extracts text from PDFs and fills forms" not "Helps with PDFs".

### 3. Write instructions, then review

```
skill_build({ path: "/path/to/skill-dir" })
```

Runs validate → evaluate. Validation errors are requirements; evaluation findings are advisory. Apply only findings that improve the user's actual scope.

Pass `diff` to focus evaluation on what changed:

```
skill_build({ path: "...", diff: "<unified diff>" })
```

**Context engineering principles:**

- **Brevity and delegation are defaults.** Include only decisions the skill must own; delegate the rest to authoritative files, tools, or references.
- **Retrieve changing facts.** Do not copy versions, inventories, commands, or policy that can drift.
- **Evaluation is advisory.** Reject findings that add speculative scope, duplicate a source of truth, or reduce concision.

## After Editing Extension Files

If the skill has a backing extension and you edited files under `~/.pi/agent/extensions/<ext-name>/`, run jit-catch before declaring done:

```
jit_catch({ diff_source: "unstaged" })
```
