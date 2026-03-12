---
name: skill-builder
description: Build, validate, and evaluate pi skills following Agent Skills spec and context engineering best practices. Use when creating new skills, reviewing existing skills, or validating skill quality.
---

# Skill Builder

## Conventions

**Reference skills** live in `~/.agents/skills/reference/` as plain `.md` files (manually loaded, not auto-discovered). Current: `handoff`, `distillation`, `index-generator`.

**Auto-discovered skills** are directories with `SKILL.md` in `~/.agents/skills/` (global) or `.pi/skills/` (project). Names: lowercase a-z, 0-9, single hyphens, 1–64 chars, must match directory name.

## Building a New Skill

### 1. Choose a Template

| Template | When to Use |
|---|---|
| `with-index` | **Default.** Large domains or significant detail. SKILL.md = compressed map; details in `references/`. |
| `with-scripts` | Skills needing executable helpers. |
| `basic` | Everything fits in one file. |

### 2. Create

```
skill_build({ name: "...", description: "...", template: "with-index" })
```

Runs scaffold → validate → evaluate. Description must be specific: "Extracts text from PDFs and fills forms" not "Helps with PDFs".

### 3. Write instructions, then review

```
skill_build({ path: "/path/to/skill-dir" })
```

Pass `diff` to focus evaluation on changes: `skill_build({ path: "...", diff: "<unified diff>" })`

**Context engineering principles:**

- **Token density.** Every directive competes for context window space. If the tool description teaches it, the skill shouldn't repeat it. Prefer fewer precise instructions over comprehensive coverage.
- **Index > embed.** SKILL.md = compressed navigational map. Details → `references/`.
- **Progressive disclosure.** Description loads by default → SKILL.md on demand → references when needed. Each layer must justify its token cost.

## After Editing Extension Files

If the skill has a backing extension, run jit-catch before declaring done:

```
jit_catch({ diff_source: "unstaged" })
```
