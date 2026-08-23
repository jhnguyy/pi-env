# Documentation conventions

This file owns repository documentation policy. Other files can point here. Do not copy these rules into navigation files.

## Placement

- `README.md` states project purpose, setup choices, and the documentation directory.
- A directory `README.md` states only the directory purpose or entry condition.
- `CONTRIBUTING.md` owns branch, pull-request, worktree, reviewer, and test workflow.
- `AGENTS.md` owns coding-agent navigation and workflow.
- Area-specific contracts and durable decisions belong under `docs/`.

## Navigation and cross-links

Use the file and directory structure as the default catalog. Navigate a directory by filename.

Do not add a sibling-file inventory to a README when the inventory repeats the visible directory structure. Such lists create another source that can become stale.

Create a separate index only when the index adds retrieval information that filenames and folders cannot show. Cross-link a specific dependency or source authority only when the relationship is not clear from the file structure.

## Prose and comments

1. Make names, types, decomposition, and tests explain behavior.
2. Leave self-descriptive code uncommented.
3. Use comments for constraints, alternatives, domain meaning, compatibility history, and safety rationale.
4. Write documentation for an external, operator, or agent contract, a durable decision, or necessary navigation.
5. Point to the source authority instead of repeating its content.
