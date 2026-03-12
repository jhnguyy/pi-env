---
name: handoff
description: Write or read a session handoff. Use when the user says "handoff", "new session", or "fresh context", when context window exceeds 50% and the task is incomplete, or when switching models mid-task.
---

# Handoff

## When to Write

- Context window estimated >50% full and task incomplete
- User says "handoff", "new session", or "fresh start"
- Switching models/providers mid-task or session has degraded (compaction, unreliable artifact tracking)

Propose writing one proactively when context pressure is visible.

## Where & Naming

| Scope | Path |
|---|---|
| Global (default) | `~/.pi/agent/handoffs/YYYYMMDD-<slug>.md` |
| Project-scoped | `<project-root>/.pi/handoffs/YYYYMMDD-<slug>.md` |

Never committed to git.

## Format

```yaml
---
created: YYYY-MM-DD
task: One-line description
status: in-progress | blocked | ready-to-start | complete
model-used: provider/model-name
---
```

**Goal** — One paragraph. What we're accomplishing, what done looks like.

**Context** — File paths and note paths to read. No embedded content.

**What Was Done** — Bulleted list. Completed steps, files changed, commands run. Terse.

**What's Next** — Ordered list. First item executable without reading anything extra.

**Open Decisions** — Unresolved questions with known options. Mark blocking ones.

**Key Constraints** — Rules the receiving agent must not violate.

**Prompt** — `Read ~/.pi/agent/handoffs/<slug>.md then continue the task.`

## Rules

- File paths only, no embedded content
- No provider-specific syntax — must work across all models
- No session transcripts — distill, don't dump
- Status must be accurate

## Reading a Handoff

Read the file, gather everything under Context, present summary and planned next steps for confirmation.

## Lifecycle

Delete once `status: complete` and the next session confirms. Review `~/.pi/agent/handoffs/` periodically — stale handoffs accumulate.
