---
name: agentic-notes
description: Creates, updates, reviews, and transforms notes for agentic workflows. Use when capturing decisions, writing durable notes, summarizing work, preparing handoffs, or creating HTML/Markdown artifacts for human-agent collaboration while respecting workspace-specific note storage policies.
---

# Agentic Notes

Portable note practice for pi environments. This skill defines what makes a useful agent-facing note; the current workspace defines where notes live and what may be touched. The **local adapter** is the workspace-specific note policy, tool contract, or convention source that supplies those storage and boundary rules.

## First: Find the Local Adapter

Before reading or writing notes, discover local rules from the current environment:

1. Project/user instructions (`AGENTS.md`, `CONTRIBUTING.md`, README, injected context)
2. Workspace note policy files (`.agents/notes.md`, `.pi/notes.md`, `docs/notes.md`, `docs/knowledge-base.md`)
3. Available note tools, note indexes, or existing nearby notes
4. The user's explicit request

If sources conflict, follow the most explicit user instruction unless it violates a higher-priority system/developer/project boundary. Then prefer the most local workspace policy over general practice. If storage, permission, or privacy boundaries are still unclear, ask before writing.

## Choose the Output

- **Markdown note**: durable source of truth, default for knowledge that should be searched and maintained.
- **HTML sidecar**: dense visual explanation, comparison, report, diagram, plan, or review artifact.
- **Interactive HTML**: temporary editor for prioritizing, tuning, annotating, or transforming data. Must include an export path such as copy-as-Markdown, copy-as-JSON, or copy-diff.

Keep a short Markdown summary for any HTML artifact that should be useful in future sessions.

## Core Workflow

1. Read the local adapter and any existing note before changing it.
2. Decide whether the task needs capture, rewrite, review, distillation, or an HTML artifact.
3. Prefer coherent rewrites over append-only updates when revising an existing note.
4. Preserve local metadata, links, boundaries, and naming conventions.
5. Keep the final note simple: clear title, concise context, decisions/facts, evidence, open questions, and next actions when relevant.

## Reference Index

Load only the reference needed for the task.

| File | Use when |
|---|---|
| [note-quality.md](references/note-quality.md) | Creating, rewriting, reviewing, or distilling durable notes |
| [html-artifacts.md](references/html-artifacts.md) | Deciding whether to create Markdown, HTML sidecars, or interactive HTML |
| [workspace-adapter-contract.md](references/workspace-adapter-contract.md) | Writing or reviewing local note boundary rules for a workspace |
| [templates.md](references/templates.md) | Need a minimal starting structure |

## Boundaries

- Never store secrets, credentials, private keys, or raw sensitive dumps in notes.
- Do not invent note locations or storage conventions.
- Do not let formatting complexity obscure the information.
- Prefer fewer, coherent sections over exhaustive templates.
