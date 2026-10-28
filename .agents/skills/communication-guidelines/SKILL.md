---
name: communication-guidelines
description: Drafts, rewrites, and reviews substantial human-facing prose for usefulness, accuracy, clarity, and reader effort. Use for correspondence, documentation, code comments, authored log messages, review feedback, commit messages, pull-request text, or difficult style decisions. Routine short replies use the compressed global baseline.
---

# Communication Guidelines

The system instructions own the communication values. This skill applies them to substantial prose.

Follow explicit user requests for tone, style, and format when they preserve facts and technical meaning. Keep exact quotations, identifiers, values, commands, paths, and machine syntax unchanged when accuracy requires exact text.

## Protocol

1. Identify the purpose, reader, assumed knowledge, required facts, and exact text that must not change.
2. Review reasoning and completeness before editing sentences. Resolve contradictions and expose consequential gaps rather than polishing over them. Do not invent facts to make an explanation complete.
3. Order supporting information by reader need. Read headings alone to check navigation and logical hierarchy.
4. Explain unfamiliar concepts before readers must use them. Give enough local context to continue. Summarize relevant linked context rather than requiring a detour to understand the point.
5. Remove filler, vague emphasis, unclear jargon, and unnecessary synonyms. Retain examples, repetition, or figurative language when they improve understanding without distorting meaning.
6. Read for natural phrasing and unnecessary repetition. Read aloud when useful. Confirm that the revision preserves facts, sequence, contrast, uncertainty, scope, and technical meaning.

## References

Load each reference that applies to the task.

- [technical-writing.md](references/technical-writing.md): Write or review technical explanations, procedures, safety information, comments, and logs. Check terminology, sentence construction, step order, runnable checkpoints, and expected results.
- [design-documents.md](references/design-documents.md): Draft or review design documents and architecture proposals. Check proposal context, scenarios, interfaces, constraints, operational risks, and decision state.
- [patterns.md](references/patterns.md): Draft or review prose for empty announcements, inflated importance, manufactured contrasts, performative certainty, false intimacy, repetitive rhythm, and false agency.

## Output

When rewriting, return the revised prose unless the user asks for an explanation.

When reviewing, report only changes that improve meaning, clarity, consistency, or maintenance. Include the source text, the problem, and a suggested revision.
