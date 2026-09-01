# Portable Note Architecture

Use this architecture to classify and maintain durable notes. The configured notes provider selects the store.

## Ownership

Give each durable item one canonical owner. A note can summarize another owner when the summary serves a different purpose. Link to the canonical owner instead of copying detailed status, evidence, or explanations.

| Question | Canonical owner |
|---|---|
| What is currently understood or practiced? | `wiki/` |
| What active outcome are we trying to complete? | `projects/` |
| What happened at a particular time? | `records/` |
| What did we decide and why? | `records/decisions/` |
| What did an external source claim? | `sources/` |
| Has this material not been classified? | `inbox/` |
| Is this implementation detail? | The owning repository |
| Is this authored for publication? | `writing/` |
| Does this define store conventions or configuration? | `_meta/` |

## Collections

- `inbox/` contains temporary capture and daily notes.
- `wiki/` contains maintained current knowledge organized by subject.
- `records/` contains dated evidence and decisions.
- `projects/` contains active outcomes organized by outcome.
- `sources/` contains external material and provenance.
- `writing/` contains drafts and published work.
- `_meta/` contains store configuration and necessary local overrides.

Use these as logical collection names. A provider can map them to backend locations while preserving their ownership and maintenance behavior.

## Records

Use chronology as the storage axis for records. Use subjects as retrieval attributes instead of record folders.

Prefer these logical paths:

```text
records/decisions/YYYY/MM/DD.md
records/worklog/YYYY/MM/DD.md
```

A decision record states its status, basis, consequences, and revisit condition when useful. Preserve accepted reasoning. Record a later correction or superseding decision instead of silently rewriting history.

A worklog records what happened. It does not own current system state or future actions. Keep a worklog only when it provides useful evidence that another canonical owner does not preserve.

## Project Lifecycle

A project note owns one active outcome. Keep its purpose, current state, constraints, blockers, and links to durable knowledge or records. Keep implementation detail in the owning repository. Keep committed actions in the canonical task system when one exists.

When a project closes:

1. Update the relevant wiki page if current understanding changed.
2. Preserve important decisions, results, and events in records.
3. Keep implementation detail in the owning repository.
4. Remove obsolete plans and duplicate summaries.
5. Close or delete the project note when it no longer owns an active outcome.

## Capture and Graduation

Use one general inbox for unclassified capture. Process each item into a project, wiki page, record, source note, writing artifact, or deletion.

Generated artifacts start as ephemeral. Make an artifact durable only when it has a future consumer, a retrieval path, and a clear canonical owner.

## Retrieval

Use several retrieval paths:

1. Use the file tree or provider index for orientation.
2. Use search for known terms and exploratory retrieval.
3. Use links to move from related information to its canonical owner.
4. Use provider inventory operations when an exhaustive list is necessary.

Write specific titles. Put current conclusions near the top. Include names, aliases, dates, commands, and other terms that a future search can find.

## Metadata

Add metadata only when a workflow consumes it. Useful fields can include project status, verification date, aliases, and cross-subject retrieval terms. Do not add metadata that only repeats the path, title, collection, or date.
