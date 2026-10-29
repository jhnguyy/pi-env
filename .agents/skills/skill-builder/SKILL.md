---
name: skill-builder
description: Builds and validates Pi skills with focused methods and retrieval boundaries. Use when creating a skill, revising its instructions, or reviewing its quality.
disable-model-invocation: true
---

# Skill Builder

Read `docs/skills.md` in the installed Pi documentation before changing a skill. Use it as the authority for format, frontmatter, discovery, and native validation rather than maintaining a separate specification or validator.

## Shape the skill

Identify the recurring task, the result the skill should help achieve, and who benefits from that result. Create a skill for a reusable method that needs more context than a prompt template, or extend an existing skill when it already covers that method.

Describe both what the skill does and when to load it. Put specialized decisions and procedures in the body, leaving shared values in the system prompt. Where the method depends on changing tool contracts or local policy, reference those authorities instead of copying them.

For skills intended only for explicit invocation, use `disable-model-invocation: true`. Preserve that boundary when revising an existing skill unless the user requests a change.

Make the method usable without a shared glossary: explain specialized terms where they affect a decision or action. Turn shared values into task-specific questions, choices, checks, and follow-through rather than repeating their definitions. Select the structure for the method; skills need not share identical sections.

Keep supporting files for detail worth loading separately or executable helpers needed by the method, and resolve bundled references relative to the skill directory. Keep examples and output templates only when they clarify a contract that prose alone would leave ambiguous.

## Validate and review

Compare the revision with the original instructions for preserved triggers, authority boundaries, safety requirements, and technical contracts. Trace a representative task through the method: can the reader choose an action, check the result, and resolve remaining responsibilities? Keep claims of completeness within what these checks establish.

Run Pi where the skill is discoverable, inspect its diagnostics, and confirm `/skill:name` loads. After edits in an active session, run `/reload`.

Request an independent qualitative review only when the user explicitly asks for one. When requested, give the reviewer the user's goal and skill diff. Examine findings through questions about the task and evidence: what misunderstanding or failure would the proposed change prevent, and which source owns the requirement? Treat findings as advisory, rejecting speculative scope, duplicated authority, or added prose that does not improve the method. Apply supported corrections and check their effects on the rest of the instructions.
