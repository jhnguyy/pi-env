---
name: communication-guidelines
description: Drafts, rewrites, and reviews substantial human-facing prose under the pi-env ASD-STE100-based house style. Use for correspondence, documentation, code comments, authored log messages, review feedback, commit messages, pull-request text, or difficult style decisions. Routine short replies use the compressed global baseline.
---

# Communication Guidelines

## Rule

Use the core principles of ASD-STE100 Simplified Technical English, Issue 9, as the default. This is a house style, not a claim of formal compliance. Follow explicit user requests for tone, style, and format when they preserve facts and technical meaning.

Be direct, specific, and useful. Preserve claims, scope, uncertainty, and technical precision. Remove wording that adds drama, intimacy, authority, or certainty without adding information.

Keep exact quotations, identifiers, commands, paths, and machine syntax unchanged when accuracy requires exact text. Apply the house style to the human-readable text around those elements.

## Protocol

1. Identify the purpose, reader, assumed knowledge, required facts, and exact text that must not change.
2. Check the document before editing sentences. Lead with the answer, request, or intended outcome. Order supporting information by reader need. Read headings alone to check navigation and logical hierarchy.
3. Explain unfamiliar concepts before readers must use them. Give enough local context to continue. Link to authoritative sources for depth rather than duplicating their specifications.
4. Give each sentence one main idea. Split long or nested sentences.
5. Prefer active voice, concrete verbs, and explicit actors when the actor is useful.
6. Use one term for each item or concept. Preserve project and subject-field terminology.
7. Put conditions before dependent actions or results.
8. Use lists for steps, alternatives, or complex information.
9. Remove filler, vague emphasis, unclear jargon, unnecessary synonyms, and figurative language.
10. Check pronouns, connectors, and prepositional phrases for more than one possible meaning.
11. Confirm that the revision preserves facts, sequence, contrast, uncertainty, scope, and technical meaning.

## Technical writing

Load [references/technical-writing.md](references/technical-writing.md) when you write or review:

- Technical documentation
- Procedures or operational instructions
- Safety information
- Code comments or authored log messages
- Other text that explains a system, component, state, or action

The reference combines a house-style summary of ASD-STE100 Issue 9 with practical documentation guidance. Do not claim formal compliance.

## Design documents

Load [references/design-documents.md](references/design-documents.md) when drafting or reviewing a design document or architecture proposal. Use the [planning skill](../planning/SKILL.md) to derive or assess the decisions before polishing their presentation.

## Pattern guide

Load [references/patterns.md](references/patterns.md) when examples of avoidable communication patterns help.

## Output

When rewriting, return the revised prose unless the user asks for an explanation.

When reviewing, report only changes that improve meaning, clarity, consistency, or maintenance. Include the source text, the problem, and a suggested revision.
