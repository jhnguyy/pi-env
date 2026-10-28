---
name: skill-builder
description: Builds and validates Pi skills with focused methods and retrieval boundaries. Use when creating a skill, revising its instructions, or reviewing its quality.
disable-model-invocation: true
---

# Skill Builder

Read `docs/skills.md` in the installed Pi documentation before changing a skill. Use it as the authority for format, frontmatter, discovery, and native validation rather than maintaining a separate specification or validator.

## Shape the skill

Create a skill for a reusable method that needs more context than a prompt template. Extend an existing skill when it already covers that method.

Describe both what the skill does and when to load it. Put specialized decisions and procedures in the body, not shared system-prompt values. Reference changing tool contracts and local policy where needed instead of copying them.

Use `disable-model-invocation: true` for skills intended only for explicit invocation. Preserve that boundary when revising an existing skill unless the user requests a change.

Keep supporting files for detail worth loading separately or executable helpers needed by the method. Resolve bundled references relative to the skill directory. Keep examples and output templates only when they clarify a contract that prose alone would leave ambiguous.

## Validate and review

Run Pi where the skill is discoverable, inspect its diagnostics, and confirm `/skill:name` loads. Run `/reload` after edits in an active session.

Request an independent qualitative review only when the user explicitly asks for one. Give the reviewer the user's goal and skill diff. Treat findings as advisory, rejecting speculative scope, duplicated authority, or added prose that does not improve the method.
