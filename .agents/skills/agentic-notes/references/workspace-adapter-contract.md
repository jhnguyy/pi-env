# Workspace Adapter Contract

Use this when creating or reviewing local note boundary rules for a workspace. The adapter should be short and concrete. It tells the portable `agentic-notes` skill how to behave locally.

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

- note storage backend or filesystem paths
- allowed prefixes
- frontmatter schema
- index conventions
- privacy boundaries
- which notes are canonical versus scratch
- whether generated HTML may be saved or committed

Do not restate general note-writing theory. Keep reusable practice in the portable skill.

## Homelab-Style Adapter Guidance

For a personal homelab vault, useful boundaries usually include:

- read current note content before editing
- prefer full coherent rewrites for design/reference/project notes
- preserve human-owned voice and existing metadata
- keep worklogs chronological and append-only unless asked otherwise
- do not expose secrets, credentials, internal URLs with tokens, or private keys
- keep generated HTML as sidecars or scratch unless promoted by the user
- update relevant indexes only when local index rules are known

## Adapter Discovery

Agents should look for adapter instructions in project/user context first. If multiple policies conflict, follow the most local and most explicit policy, then ask if still ambiguous.
