# Documentation conventions

This file defines repository documentation policy.

## Placement

- `README.md` states project purpose, setup choices, and the documentation directory.
- A directory `README.md` states only the directory purpose or entry condition.
- The [`code-contribution` skill](../../.agents/skills/code-contribution/SKILL.md) owns the portable contribution method.
- `CONTRIBUTING.md` owns pi-env-specific contribution requirements.
- `AGENTS.md` owns coding-agent navigation.
- Keep roadmaps, proposed architecture, migration sequencing, research, and open decisions in project notes, not usage or convention docs.
- When documenting a behavioral requirement, distinguish it from implemented support.

## Navigation and cross-links

Use the file and directory structure as the default catalog. Navigate a directory by filename.

Do not add a sibling-file inventory to a README when the inventory repeats the visible directory structure. Such lists create another source that can become stale.

Create a separate index only when the index adds retrieval information that filenames and folders cannot show. Cross-link a specific dependency or source authority only when the relationship is not clear from the file structure.

## Content, prose, and comments

- The [system prompt](../../.pi/agent/APPEND_SYSTEM.md) defines the shared vocabulary, practice, and communication values, including a single authoritative home for each fact, rule, and decision.
- The Documentation section of the [global agent guidelines](../../setup/templates/AGENTS.md#documentation) defines what to document and when to comment.
- The [communication-guidelines skill](../../.agents/skills/communication-guidelines/SKILL.md) develops technical-writing methods and comment style.
- The [skill-builder skill](../../.agents/skills/skill-builder/SKILL.md) defines skill authoring and validation, including how task-specific methods apply the shared concepts.
