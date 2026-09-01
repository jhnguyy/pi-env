---
name: agentic-notes
description: Creates, updates, reviews, and transforms notes with a portable behavior-first architecture. Use when capturing decisions, maintaining knowledge, summarizing work, preparing handoffs, or creating HTML/Markdown artifacts for human-agent collaboration.
---

# Agentic Notes

Portable note practice for pi environments. This skill defines a default architecture for classifying, retrieving, and maintaining notes. It also defines what makes a useful agent-facing note.

The local pi environment selects storage through its configured extensions and available tools. Local instructions supply only necessary access, privacy, retention, or organization-specific overrides.

## First: Discover the Active Store

Before reading or writing notes:

1. Read project and user instructions such as `AGENTS.md`, `CONTRIBUTING.md`, and the README.
2. Identify the available notes tool or documented filesystem access path.
3. Read existing notes, indexes, and applicable local overrides before editing.
4. Apply the user's explicit request.

Treat the configured tool as the active store boundary. Do not ask the user to select a context that the environment already selected. If no supported access path exists, stop and ask instead of inventing a store or bypassing its provider.

Use the portable architecture when no local override applies. If sources conflict, follow the most explicit user instruction unless it violates a higher-priority boundary. Then prefer the most local applicable override.

## Choose the Output

- **Markdown note**: durable source of truth, default for knowledge that should be searched and maintained.
- **HTML sidecar**: dense visual explanation, comparison, report, diagram, plan, or review artifact.
- **Interactive HTML**: temporary editor for prioritizing, tuning, annotating, or transforming data. Must include an export path such as copy-as-Markdown, copy-as-JSON, or copy-diff.

Keep a short Markdown summary for any HTML artifact that should be useful in future sessions.

## Core Workflow

1. Discover the active store and read any existing note before changing it.
2. Classify durable information with the portable architecture.
3. Decide whether the task needs capture, rewrite, review, distillation, or an HTML artifact.
4. Prefer coherent rewrites over append-only updates when revising current knowledge.
5. Preserve applicable metadata, links, boundaries, and naming conventions.
6. Keep the final note simple: clear title, concise context, decisions or facts, evidence, open questions, and next actions when relevant.

## Reference Index

Load only the reference needed for the task.

| File | Use when |
|---|---|
| [portable-note-architecture.md](references/portable-note-architecture.md) | Classifying durable information or deciding its canonical owner and lifecycle |
| [note-quality.md](references/note-quality.md) | Creating, rewriting, reviewing, or distilling durable notes |
| [html-artifacts.md](references/html-artifacts.md) | Deciding whether to create Markdown, HTML sidecars, or interactive HTML |
| [local-overrides.md](references/local-overrides.md) | Defining necessary workspace exceptions to the portable defaults |
| [templates.md](references/templates.md) | Need a minimal starting structure |

## Boundaries

- Never store secrets, credentials, private keys, or raw sensitive dumps in notes.
- Do not bypass the configured provider or invent store locations.
- Do not let formatting complexity obscure the information.
- Prefer fewer, coherent sections over exhaustive templates.
