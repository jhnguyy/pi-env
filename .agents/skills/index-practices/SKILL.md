---
name: index-practices
description: Writing and maintaining navigational indices for codebases. Use when creating a new index, updating an existing one, or deciding whether an index is needed.
---

# Index Practices

An index is a compressed navigational map — not documentation. It sits in passive context so agents can decide *which file to read* without reading all of them.

## Writing One-Liners

The one-liner is the entire value of an index entry. A good one-liner lets an agent answer "should I read this file?" for a specific question.

| ❌ Noise | ✅ Signal |
|---|---|
| "Manages git operations" | "git op wrappers — commit, push, fetch, revert; 5s timeout" |
| "Handles formatting" | "TypeScript formatter via LSP, workspace-aware, auto-runs on save" |
| "Overview of the migration" | "REST→GraphQL: 47 endpoints, v1 deprecated 2024-11-15, rollback 48h" |

**Retrievability test:** If an agent searching for "how does the formatter work" reads your one-liner and still can't decide whether to open the file — rewrite it.

Lead with the most distinctive fact. File names, format names, numbers, decisions, constraints — not verbs like "handles", "manages", "supports".

## Format

Pipe-delimited, one line per group. Used in `.pi/AGENTS.md` and similar structural indices.

```
[Domain Index]|context line
|<group>:{file1(one-liner),file2(one-liner)}
|<group>:{file3(one-liner)}
```

- Group by functional area, not alphabetically
- List core modules per extension, not every file
- One line per group, not one line per file

## When to Update

**Update now** if you added, removed, or renamed an indexed file — the index has a broken ref or missing entry.

**Defer** if you only changed implementation details within a file already in the index. The one-liner still describes the file's purpose correctly. Note it for later if the change was significant enough to shift what the file "is about."

**Skip** if you're mid-task on something unrelated. Don't context-switch to index maintenance unless you hit a broken ref that's blocking your work.

## Staleness

If an index references a file that doesn't exist, flag it immediately — don't silently skip. Stale indices mislead worse than no index.

If you discover staleness mid-task: fix the broken entry (one-line edit), don't audit the whole index. Full audits are a separate task.

Read the existing index before overwriting — preserves structure and entries added by others since last generation.
