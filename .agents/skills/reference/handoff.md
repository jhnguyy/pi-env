---
name: handoff
description: Write or read a session handoff. Use when the user says "handoff", "new session", or "fresh context", when context window exceeds 50% and the task is incomplete, or when switching models mid-task.
---

# Handoff

## When to Write

Write a handoff when **any** of these apply:

- Context window is estimated >50% full and the task is incomplete
- User says "handoff", "write a handoff", "new session", or "fresh start"
- Switching models or providers mid-task
- Session has degraded — compaction has run, or artifact tracking feels unreliable

Do not wait to be asked. Propose writing one when context pressure is visible.

## Where Handoffs Live

| Scope | Path |
|---|---|
| Global (default) | `~/.pi/agent/handoffs/<slug>.md` |
| Project-scoped | `<project-root>/.pi/handoffs/<slug>.md` |

Use global by default. Use project-scoped only when the task is tightly bound to one repo. Handoff files are **never committed to git**.

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

**Context** — File paths and note paths the receiving agent must read. No embedded content — paths only.

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

**Prompt** — One line for the user to paste into a new session:
```
Read ~/.pi/agent/handoffs/<slug>.md then continue the task.
```

## Writing Rules

- **No embedded content.** File paths only — the receiving agent reads them directly.
- **No provider-specific syntax.** Must work across Claude, GPT-4, Gemini, and local models.
- **No session transcripts.** Distill, don't dump.
- **Status must be accurate.** A handoff marked `complete` that isn't is worse than no handoff.
- **Prompt section is required.** It is the only entry point for the next agent.

## Naming

`YYYYMMDD-<slug>.md` — short kebab-case, date prefix. Example: `20260302-auth-refactor.md`.

## Reading a Handoff

Read the file, gather everything listed under Context, then present a summary of what you found and the planned next steps for confirmation before acting.

## Lifecycle

Delete once `status: complete` and the following session confirms done. Review `~/.pi/agent/handoffs/` periodically — stale handoffs accumulate quickly.
