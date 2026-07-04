# Workspace Adapter Contract

Use this when creating or reviewing local note boundary rules for a workspace. The adapter should be short and concrete. It tells the portable `agentic-notes` skill how to behave locally.

Adapters separate portable method from local storage. The portable skill defines note quality and rewrite judgment. The adapter defines paths, tools, backends, credentials, write permissions, and privacy boundaries.

## Minimal Adapter

```markdown
# Workspace Notes Policy

## Storage
- Canonical notes live in: ...
- Scratch artifacts live in: ...
- HTML sidecars live in: ...

## Access Boundaries
- Agents may read: ...
- Agents may write/edit: ...
- Ask before touching: ...
- Never read/write: ...

## Update Policy
- Prefer coherent rewrites for reference/design/project notes.
- Use append-only updates only for worklogs, timelines, or audit trails.

## Conventions
- Naming/path rules: ...
- Required metadata: ...
- Link syntax: ...
- Index/MOC rules: ...

## Privacy
- Secret handling: ...
- Sensitive personal/project boundaries: ...
```

## What Belongs in the Adapter

Include local facts only:

- note storage backend, tool contract, or filesystem paths
- provider/backend names and default provider choice
- allowed prefixes
- frontmatter schema
- index conventions
- privacy boundaries
- which notes are canonical versus scratch
- whether generated HTML may be saved or committed

Do not restate general note-writing theory. Keep reusable practice in the portable skill.

## Adapter Guidance

Useful adapters usually specify:

- the canonical access path, such as a tool contract or filesystem root
- whether agents may write directly or must ask first
- when existing content must be read before editing
- metadata, link, and index conventions to preserve
- which records are append-only versus rewrite-friendly
- secret and sensitive-data boundaries

## Adapter Discovery

Agents should look for adapter instructions in project/user context first. If multiple policies conflict, follow the most local and most explicit policy, then ask if still ambiguous.
