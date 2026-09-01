# Local Note Overrides

Use local overrides only when the portable note architecture cannot express a workspace requirement. The configured notes extension selects the provider, store, credentials, and tool contract. A workspace does not need a separate package or policy note only to identify its environment.

## Minimal Override

```markdown
# Workspace Note Overrides

## Access Boundaries
- Agents may read: ...
- Agents may write or edit: ...
- Ask before touching: ...
- Never read or write: ...

## Canonical Systems
- Tasks: ...
- Implementation: ...
- Publication: ...

## Conventions
- Required metadata: ...
- Link syntax: ...
- Provider limitations: ...

## Privacy and Retention
- Sensitive data boundaries: ...
- Retention requirements: ...
```

Include only facts that differ from the portable architecture or provider configuration. Do not copy:

- provider names, endpoints, credentials, or store paths from settings
- general note-writing guidance
- the portable collection and ownership rules
- defaults that the notes tool already enforces

## Discovery

Look for local overrides in this order:

1. Project and user instructions such as `AGENTS.md`
2. Workspace files such as `.agents/notes.md`, `.pi/notes.md`, `docs/notes.md`, or `docs/knowledge-base.md`
3. A store-local `_meta/` note when the configured notes tool exposes one
4. The user's explicit instruction

Follow the most local and explicit applicable rule. If no override exists, use the portable architecture without creating one.
