# Reference skill invocation

Reference skills use Pi's standard `.agents/skills/<name>/SKILL.md` layout. Each reference skill sets `disable-model-invocation: true`. This keeps its description out of passive skill context but leaves native explicit invocation available. The `reference` directory and its custom discovery convention are removed.

Use `/skill:<name>` with the exact frontmatter name. For example:

```text
/skill:planning Plan the migration
/skill:teach Explain this module
```

Use `/skill:` command completion to browse available skills. Text after the command becomes the skill's user argument. Interactive command registration and completion use `enableSkillCommands: true`, which is Pi's default. Session command expansion does not depend on that setting.

Personal reference skills can use the same `~/.agents/skills/<name>/SKILL.md` layout. Pi also discovers nested Markdown files under `~/.agents/skills` and direct Markdown children of `~/.pi/agent/skills`. Explicit paths in Pi's `skills` settings are another option. Set `disable-model-invocation: true` when personal reference skills should stay out of passive context. Pi owns name collisions and reload behavior.

The former `reference_skill` tool is removed from Pi, subagents, and PTC. Replace calls with native skill commands in hosts that support them. Custom case-insensitive names and filename aliases are not retained. Remove the old tool name from personal tool profiles or agent tool lists that specify it. This change does not edit user settings or personal skill files.

This flag controls prompt visibility, not file access or authorization. An agent with file access can still read a skill. It does not guarantee that natural-language requests will select a hidden skill.

`skill_build` still creates, validates, and evaluates authored skills. Its validation and evaluation behavior is unchanged.
