---
name: index-generator
description: Produce a compressed navigational index for any set of files or notes. Use when asked to index a folder, a codebase section, or any collection where an agent or human needs to orient quickly without reading everything.
---

# Index Generator

A compressed index in passive context consistently outperforms on-demand retrieval. 8KB compressed ≈ 40KB full embed.

## What a Good Index Is

A navigational map, not documentation. One line per entry with the most distinctive, retrievable facts.

| Bad | Good |
|---|---|
| "Overview of the API migration project" | "REST→GraphQL migration: 47 endpoints, v1 deprecated 2024-11-15, rollback 48h" |
| "AI reference notes" | "Vercel eval: passive context (100%) vs skills (53%); compression strategy" |
| "Server config notes" | "nginx: rate limit 100 req/s, upstream timeout 30s, SSL cert expires 2026-03" |

## Format

Adapt to context. Markdown/notes vaults:

```markdown
## <Group>

| Entry | [Status] | Summary |
|---|---|---|
| [[path/to/note]] | active | One-liner: key facts, numbers, decisions |
```

Code/docs (pipe-delimited, AGENTS.md-style):

```
[<Domain> Index]
|<subfolder>:{file1 — one-liner, file2 — one-liner}
```

**Rules:** One line per entry. Concrete details (names, numbers, statuses, decisions) — not topic summaries. Status column only where entries have meaningful state. Group by subdomain when large; link to sub-indexes.

## Process

1. **Enumerate** — list all files/notes in scope
2. **Read** — read each entry; read any existing index first to preserve intentional structure
3. **Write** — one-liner per entry, lead with the most distinguishing fact
4. **Link up** — if sub-index, verify parent references it

## Maintenance

- Read before overwriting — avoid dropping entries added since last generation
- Verify status fields from source, not memory
- Remove entries for deleted files; create sub-indexes for new subdomains
