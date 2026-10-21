---
name: skill-builder
description: Build, review, and validate Pi skills with context engineering practice. Use when creating a new skill, revising an existing skill, or reviewing skill quality.
disable-model-invocation: true
---

# Skill Builder

Pi's skills documentation (`docs/skills.md` in the Pi docs) owns the skill format, frontmatter, discovery locations, and validation method. Read it before you create or change a skill.

## Decide the form

- Create a skill only when a repeated method needs more context than `AGENTS.md` or a prompt template should carry. Prefer to extend an existing skill that owns the method.
- Set `disable-model-invocation: true` when the skill applies only on explicit request. A reference skill costs no context until `/skill:name` loads it.
- Add supporting files only for stable detail that is worth retrieving separately, or for executable helpers that are part of the capability.

## Write the method

- **Brevity and delegation are defaults.** Include only decisions the skill must own. Delegate the rest to authoritative files, tools, or references.
- **Retrieve changing facts.** Do not copy versions, inventories, commands, or policy that can drift.
- Make the description specific and actionable: "Extracts text from PDFs and fills forms", not "Helps with PDFs".

## Validate and review

- Validate with Pi's native method: run `/reload`, read the skill diagnostics, and confirm that `/skill:name` loads.
- Request an independent review only when the user asks for qualitative review. Give the reviewer the user's goal and the skill diff. Treat its findings as advisory. Reject findings that add speculative scope, duplicate a source of truth, or reduce concision.
