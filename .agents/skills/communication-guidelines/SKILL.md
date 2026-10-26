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
6. Use one term for each item or concept. Check domain terms against the sources described in the technical-writing reference.
7. Put conditions before dependent actions or results.
8. Use lists for steps, alternatives, or complex information.
9. Remove filler, vague emphasis, unclear jargon, unnecessary synonyms, and figurative language.
10. Check pronouns, connectors, and prepositional phrases for more than one possible meaning.
11. Confirm that the revision preserves facts, sequence, contrast, uncertainty, scope, and technical meaning.

## References

Load each reference that applies to the task.

- [technical-writing.md](references/technical-writing.md): Write or review technical explanations, procedures, safety information, comments, and logs. Check terminology, sentence construction, step order, runnable checkpoints, and expected results.
- [design-documents.md](references/design-documents.md): Draft or review design documents and architecture proposals. Check proposal context, scenarios, interfaces, constraints, operational risks, and decision state.
- [patterns.md](references/patterns.md): Draft or review prose for empty announcements, inflated importance, manufactured contrasts, performative certainty, false intimacy, repetitive rhythm, and false agency.

## Output

When rewriting, return the revised prose unless the user asks for an explanation.

When reviewing, report only changes that improve meaning, clarity, consistency, or maintenance. Include the source text, the problem, and a suggested revision.
