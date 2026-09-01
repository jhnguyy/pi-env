---
name: agentic-notes
description: Uses the configured notes interface to create, update, review, and transform durable notes and related artifacts. Use when capturing decisions, maintaining knowledge, summarizing work, preparing handoffs, or creating HTML/Markdown artifacts.
---

# Agentic Notes

Use the `notes` tool that the local pi environment provides. The extension configuration owns the provider, store, credentials, and access boundary.

Follow the tool contract for retrieval and mutation. Create or update the smallest coherent artifact that satisfies the request. Preserve useful metadata, links, naming conventions, and the human's voice.

Do not bypass the configured notes tool or ask the user to select a store that the environment already selected. If the tool is unavailable, stop and ask instead of inventing a storage path.

## Choose the Output

- **Markdown note**: durable source of truth.
- **HTML sidecar**: dense visual explanation, comparison, report, diagram, or plan.
- **Interactive HTML**: temporary editor for prioritizing, annotating, or transforming data. Include an export path.

Keep a short Markdown summary for any HTML artifact that should remain useful in future sessions.

## Reference Index

Load only the reference needed for the task.

| File | Use when |
|---|---|
| [portable-note-architecture.md](references/portable-note-architecture.md) | Classifying durable information or deciding its canonical owner and lifecycle |
| [note-quality.md](references/note-quality.md) | Creating, rewriting, reviewing, or distilling durable notes |
| [html-artifacts.md](references/html-artifacts.md) | Deciding whether to create Markdown, HTML sidecars, or interactive HTML |
| [templates.md](references/templates.md) | Need a minimal starting structure |

## Boundaries

- Never store secrets, credentials, private keys, or raw sensitive dumps in notes.
- Do not let formatting complexity obscure the information.
- Prefer fewer, coherent sections over exhaustive templates.
