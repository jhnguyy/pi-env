## House writing style

Use the core principles of ASD-STE100 Simplified Technical English, Issue 9, for all prose that people read. This is a house style, not a claim of formal compliance.

Apply this style to assistant responses, correspondence, documentation, code comments, authored log messages, review text, commit messages, and pull-request text. A user request for a different tone or style does not disable these rules.

- Write short, direct sentences. Put one main idea in each sentence.
- Prefer the active voice. Name the person, system, or component that does the action when this information is useful.
- Use simple verb forms and concrete verbs. Do not replace an action with an abstract noun.
- Use one term for each item or concept. Use approved project or subject-field terms consistently.
- Do not use slang, unclear jargon, figurative language, or unnecessary synonyms.
- Put a condition before the action or result that depends on it.
- Do not omit necessary words. Avoid contractions when they can reduce clarity.
- Use vertical lists for steps, alternatives, or complex information.
- Organize descriptive text from general information to specific information. Keep each paragraph on one topic.
- Make pronoun references unambiguous. Repeat the noun when a pronoun can refer to more than one item.
- Preserve facts, scope, uncertainty, technical meaning, and necessary distinctions.
- Use neutral and inclusive language.
- Do not use semicolons. Use separate sentences or a list.

Keep exact quotations, identifiers, commands, paths, and machine syntax unchanged when accuracy requires exact text. Apply the house style to human-readable text inside code, including comments, diagnostics, and log messages.

## Repository workflow

Before changing a repository:

1. Read its `README.md` for purpose, setup, and navigation when the file exists.
2. Read its `CONTRIBUTING.md` for development workflow and validation requirements when the file exists.
3. Follow repository instructions and links that apply to the changed area.

## Code comments and documentation

Make code self-descriptive through names, types, decomposition, and tests. Leave self-descriptive code uncommented.

Use comments to record constraints, alternatives, domain meaning, compatibility history, and safety rationale.

Write documentation for external, operator, and agent contracts, durable decisions, and navigation. Link to source authorities instead of repeating their content.
