# Note Quality

A good agentic note is easy for a human to read and easy for a future agent to retrieve, trust, and act on.

## Durable Note Shape

Use the smallest structure that makes the note coherent:

```markdown
# Clear Title

Brief summary of what this note is for.

## Context
Why this exists and what situation it describes.

## Current Understanding
Facts, decisions, constraints, or model of the system.

## Evidence
Links, citations, observations, commands, or sources that support the understanding.

## Open Questions
Unknowns that should not be treated as settled.

## Next Actions
Concrete follow-up, only when action is needed.
```

Not every note needs every section. Do not keep empty sections.

## Rewrite Policy

When updating an existing note, prefer a coherent rewrite over an append-only log if the note is meant to be a current reference. Preserve useful history only when it explains present decisions.

Use append-only sections for:

- worklogs
- incident timelines
- audit trails
- journals
- cases where local policy explicitly requires append-only records

For reference, design, overview, and project notes, integrate new information into the right section and remove stale duplication.

## Retrieval Quality

Make notes findable by their likely future questions:

- Use a title with specific nouns, not vague labels.
- Put the conclusion near the top.
- Include names, aliases, systems, dates, and commands people may search for.
- Link related notes when local syntax is known.
- Keep local frontmatter/schema intact.

## Agent Trust Markers

Separate:

- confirmed facts
- decisions
- assumptions
- hypotheses
- open questions
- next actions

Future agents should be able to tell what is known versus what still needs verification.

## Simplicity Standard

Prefer plain Markdown and direct prose. Tables, checklists, HTML, diagrams, and metadata are useful only when they reduce cognitive load.
