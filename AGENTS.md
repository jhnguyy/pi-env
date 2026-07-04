# AGENTS.md

## Workflow

Before making changes:

1. Read [`README.md`](README.md).
2. Read [`CONTRIBUTING.md`](CONTRIBUTING.md).
3. Identify the closest existing convention in nearby code, tests, docs, and package scripts before editing.

## Development Principles

- Build small, composable pieces with clear ownership boundaries.
- Keep source-of-truth values in one place; derive checks and messages from that source instead of duplicating constants.
- Prefer rigorous, typed, reusable modules once shell glue starts carrying branching logic, validation, or repeated formatting.
- Make automation convergent: inspect current state, apply only necessary changes, and validate outcomes.
- Optimize for context economy. Retrieve the smallest useful slice before reading large files, session logs, generated artifacts, or tool output.
- Preserve portability: distinguish host-local configuration from repo-managed behavior, and avoid assuming a specific machine unless the docs establish that expectation.

## Code Intelligence

Use `dev-tools` for supported code navigation before falling back to text search: symbols for orientation, definition/references for ownership, call hierarchy before signature changes, and diagnostics after edits. Use `rg` for comments, strings, configs, and other plain-text searches.

