---
name: handoff
description: Write or read a session handoff. Use when the user explicitly asks for a handoff, new session, fresh context, or continuation from a handoff.
---

# Handoff

## When to Write

Write a handoff when the user requests one. You can suggest a handoff when context pressure, compaction, unreliable state tracking, or a model switch threatens continuity.

## Where Handoffs Live

Use the location and lifecycle from the local storage adapter or user instruction. If neither identifies a destination, ask before storing the handoff. Return the handoff as text when durable storage is not required.

## Format

### Frontmatter

```yaml
---
created: YYYY-MM-DD
task: One-line description of what is being worked on
status: in-progress | blocked | ready-to-start | complete
model-used: provider/model-name
---
```

### Required Sections

**Goal** — One paragraph. What are we trying to accomplish? What does done look like?

**Context** — File paths and note paths the receiving agent must read. Include small, indispensable facts that the sources do not preserve.

```
Files:
- /absolute/path/to/file.ts

Notes:
- domain/topic/note.md
```

**What Was Done** — Bulleted list. Completed steps, files changed, commands run. Terse.

**What's Next** — Ordered list. First item must be executable without reading anything extra.

**Open Decisions** — Unresolved questions with known options. Mark blocking ones.

**Key Constraints** — Rules the receiving agent must not violate.

**Prompt** — One line for the user to paste into a new session. Use the actual handoff location:
```
Read <handoff-path> then continue the task.
```

## Writing Rules

- Prefer source paths over copied content that can drift.
- Include enough context to resume when a material fact exists only in the session.
- Use provider-neutral language.
- Distill the work. Do not include session transcripts.
- Keep the status accurate.
- Include a short prompt that gives the receiving agent an entry point.

## Naming

Follow the local storage convention. If none exists, use `YYYYMMDD-<short-kebab-case-slug>.md`.

## Reading a Handoff

Read the file and gather the sources listed under Context. Continue within the authority already given by the handoff and current request. Ask for confirmation only when intent, authority, or a consequential choice remains unclear.

## Lifecycle

Follow the local storage adapter or user instruction for retention and cleanup.
