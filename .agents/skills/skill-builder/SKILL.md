---
name: skill-builder
description: Build, validate, and evaluate pi skills following Agent Skills spec and context engineering best practices. Use when creating new skills, reviewing existing skills, or validating skill quality.
---

# Skill Builder

## Conventions

**Reference skills** — lightweight skills that live in `~/.agents/skills/reference/` or a package-root `.agents/skills/reference/` directory as plain `.md` files. They are loaded only when explicitly referenced, not through passive skill context.

**Auto-discovered skills** — directories with `SKILL.md` in a configured Pi skill path. Names use lowercase letters, digits, and single hyphens, with a maximum of 64 characters.

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

Scaffolds and validates the structure. Replace the placeholders with the smallest sufficient method, then validate the finished skill by path.

Description must be specific and actionable: "Extracts text from PDFs and fills forms" not "Helps with PDFs".

### 3. Write instructions, then validate

```
skill_build({ path: "/path/to/skill-dir" })
```

Validation is deterministic. Fix validation errors before evaluation.

Run one advisory evaluation only when the user requests qualitative review:

```
skill_build({
  path: "/path/to/skill-dir",
  action: "evaluate",
  goal: "The user's requested outcome and scope."
})
```

The evaluator uses uncommitted `SKILL.md` index and working-tree changes against `HEAD`.
If no local diff exists, it reviews the full file.
Return findings for user review. Do not rerun only to obtain a pass.

**Context engineering principles:**

- **Brevity and delegation are defaults.** Include only decisions the skill must own. Delegate the rest to authoritative files, tools, or references.
- **Retrieve changing facts.** Do not copy versions, inventories, commands, or policy that can drift.
- **Evaluation is advisory.** Reject findings that add speculative scope, duplicate a source of truth, or reduce concision.

## After Editing Extension Files

If the skill has a backing extension and you edited files under `~/.pi/agent/extensions/<ext-name>/`, run jit-catch before declaring done:

```
jit_catch({ diff_source: "unstaged" })
```
