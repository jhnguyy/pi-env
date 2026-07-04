# AGENTS.md

## Workflow

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before making any changes.
Before editing, look for existing local conventions in `README.md`, `CONTRIBUTING.md`, nearby code, tests, and prior project documentation. Prefer extending established patterns over inventing parallel ones.

## Development Principles

- Build small, composable pieces with clear ownership boundaries.
- Keep source-of-truth values in one place; derive checks and messages from that source instead of duplicating constants.
- Prefer rigorous, typed, reusable modules once shell glue starts carrying branching logic, validation, or repeated formatting.
- Make automation convergent: inspect current state, apply only necessary changes, and validate outcomes.
- Optimize for context economy. Retrieve the smallest useful slice of information before reading large files, session logs, generated artifacts, or tool output.
- Preserve portability: distinguish host-local configuration from repo-managed behavior, and avoid assuming a specific machine unless the docs establish that expectation.

## Code Intelligence

Prefer `dev-tools` over grep/read for **all** code navigation in TypeScript/JS/Bash/Nix codebases. It's faster, precise, and avoids reading entire files:

- `dev-tools symbols` — orient in a file or search workspace symbols. Use instead of reading a file top-to-bottom.
- `dev-tools definition` — jump to where a symbol is defined. Use instead of grep + read.
- `dev-tools implementation` — find concrete implementations of an interface or abstract method.
- `dev-tools references` — find all usages of a symbol across the codebase. Use instead of `grep -r`.
- `dev-tools incoming-calls` — find all callers of a function. Use before changing a signature.
- `dev-tools outgoing-calls` — find all callees of a function. Use to map dependencies before refactoring.
- `dev-tools hover` — get type info and docs at a position. Use instead of reading the declaration file.

**Before renaming or changing a function signature**, use `dev-tools references` or `dev-tools incoming-calls` to find all call sites first.

**After writing or editing code**, check LSP diagnostics (auto-injected) and fix errors before proceeding.

Use `grep`/`rg` **only** for text/pattern searches (comments, strings, config values) where LSP cannot help.

## Subagent Model Selection

Match model to task. `subagent()` inherits the parent model by default — override it. Read-heavy gathering, file summarization, and mechanical edits should use a cheap model (`anthropic/claude-haiku-4-5`). Reserve the parent model for tasks requiring judgment, adversarial thinking, or subtle tradeoff analysis.

## JavaScript Tooling

Prefer `nub` over `node`, `bun`, `npm`, `npx`, `pnpm`, and `yarn`: run files with `nub <file>`, scripts with `nub run <script>`, local CLIs with `nubx <tool>`, and installs with `nub install` / `nub add`. Use `nub --node <file>` only when strict, unaugmented Node behavior is required.
