---
name: agentic-notes
description: Creates, updates, reviews, and transforms notes for agentic workflows. Use when capturing decisions, writing durable notes, summarizing work, preparing handoffs, or creating HTML/Markdown artifacts for human-agent collaboration while respecting workspace-specific note storage policies.
---

# Agentic Notes

Portable note practice for pi environments. This skill defines what makes a useful agent-facing note. The current workspace defines where notes live and what may be touched. The **local adapter** is the workspace-specific note policy, tool contract, or convention source that supplies those storage and boundary rules.

## First: Find the Local Adapter

Before reading or writing notes, discover local rules from the current environment:

1. Project/user instructions (`AGENTS.md`, `CONTRIBUTING.md`, README, injected context)
2. Workspace note policy files (`.agents/notes.md`, `.pi/notes.md`, `docs/notes.md`, `docs/knowledge-base.md`)
3. Available note tools, note indexes, or existing nearby notes
4. The user's explicit request

If sources conflict, follow the most explicit user instruction unless it violates a higher-priority system/developer/project boundary. Then prefer the most local workspace policy over general practice. If storage, permission, or privacy boundaries are still unclear, ask before writing.

## Choose the Lifecycle and Output

- **Unclassified capture**: preserve the source in the adapter-designated capture location. Do not require capture to match a destination schema.
- **Markdown note**: durable source of truth for knowledge with a known owner and retrieval path.
- **HTML sidecar**: dense visual explanation, comparison, report, diagram, plan, or review artifact.
- **Interactive HTML**: temporary editor for prioritizing, tuning, annotating, or transforming data. Must include an export path such as copy-as-Markdown, copy-as-JSON, or copy-diff.

Keep a short Markdown summary for any durable HTML artifact.

## Core Workflow

1. Read the local adapter and any existing destination note before changing durable state.
2. Determine whether the request is unclassified capture, a known-destination update, or inbox processing.
3. For unclassified capture, preserve the local capture unit and use the adapter's capture policy.
4. For inbox processing, propose classification and destination mutations. Obtain approval before applying durable changes unless the request already specifies the destination and change. Validate transformed output against destination rules, not the capture format.
5. For a known destination, prefer a coherent rewrite over an append-only update when revising an existing note.
6. Preserve local metadata, links, boundaries, naming conventions, and the human's meaning.
7. Keep durable output simple: clear title, concise context, decisions or facts, evidence, open questions, and next actions when relevant.

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
- Do not silently classify or promote unclassified capture into canonical knowledge.
- Do not let formatting complexity obscure the information.
- Prefer fewer, coherent sections over exhaustive templates.
