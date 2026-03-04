---
name: index-generator
description: Produce a compressed navigational index for any set of files or notes. Use when asked to index a folder, a codebase section, or any collection where an agent or human needs to orient quickly without reading everything.
---

# Index Generator

Agents miss retrieval tool calls roughly half the time — a compressed index in passive context consistently outperforms on-demand retrieval at the same quality. 8KB compressed ≈ 40KB full embed.

## What a Good Index Is

A navigational map, not documentation. One line per entry with the most distinctive, retrievable facts — not a description of what the file is.

| Bad | Good |
|---|---|
| "Overview of the API migration project" | "REST→GraphQL migration: 47 endpoints, v1 deprecated 2024-11-15, rollback window 48h" |
| "AI reference notes" | "Vercel eval: passive context (100%) vs skills (53%); compression strategy" |
| "Server config notes" | "nginx: rate limit 100 req/s, upstream timeout 30s, SSL cert expires 2026-03" |

## Format

Adapt to context. For markdown/notes vaults:

```markdown
## <Group>

| Entry | [Status] | Summary |
|---|---|---|
| [[path/to/note]] | active | One-liner: key facts, numbers, decisions made |
```

For code or docs (pipe-delimited, AGENTS.md-style):

```
[<Domain> Index]
|<subfolder>:{file1 — one-liner, file2 — one-liner}
|<subfolder>:{file3 — one-liner}
```

Rules regardless of format:
- One line per entry, no sub-bullets
- Concrete details: names, numbers, statuses, decisions — not summaries of topics
- Status column only where entries have meaningful state (projects, tasks)
- Group by subdomain when the set is large; link to sub-indexes rather than flattening everything

## Process

1. **Enumerate** — list all files/notes in scope
2. **Read** — read each entry you don't already have context on; read any existing index first to preserve intentional structure
3. **Write** — one-liner per entry, lead with the most distinguishing fact
4. **Link up** — if this is a sub-index, verify the parent index references it

## Maintenance

- Read before overwriting — avoids dropping entries added since last generation
- Status fields drift; verify from source, not memory
- Remove entries for files that no longer exist
- When a new subdomain appears, create its index and add it to the parent
