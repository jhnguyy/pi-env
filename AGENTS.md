# AGENTS.md

## JavaScript Tooling

Prefer `nub` over `node`, `bun`, `npm`, `npx`, `pnpm`, and `yarn`: run files with `nub <file>`, scripts with `nub run <script>`, local CLIs with `nubx <tool>`, and installs with `nub install` / `nub add`. Use `nub --node <file>` only when strict, unaugmented Node behavior is required.

## Code-Quality Harness

Before writing any new function, search the repo for an existing one. State what you searched and found.

Run `nub run check:all` before considering any code task complete. For more readable findings, run `nub run harness:report`.

Canonical locations for cross-cutting concerns in this repo:

- Validation and install/package checks: `scripts/*-contract.mjs`, `scripts/verify*.mjs`, `setup/__tests__/`, and `.pi/extensions/skill-builder/validator.ts`.
- Dependency and duplication sensors: `.dependency-cruiser.cjs`, `.jscpd.json`, `knip.json`, `.pi/code-sensors.json`, and `.pi/extensions/dev-tools/code-sensors.ts`.
- HTTP/web access: `.pi/extensions/web-context/`; do not add ad hoc HTTP fetching elsewhere unless the extension owns that integration.
- Config/settings access: `setup/config/`, `setup/templates/`, `.pi/extensions/_shared/settings.ts`, and `.pi/extensions/_shared/agent-settings.ts`.
- Error handling: `.pi/extensions/_shared/errors.ts`; use `formatError(e, "label")` for caught errors returned to tools.
- Tool result shape: `.pi/extensions/_shared/result.ts`; prefer `txt()`, `ok()`, and `err()` over one-off result objects.
- TUI rendering helpers: `.pi/extensions/_shared/render.ts` and `.pi/extensions/_shared/ui-render.ts`.
- Git/worktree state: `.pi/extensions/_shared/git.ts` and `.pi/extensions/work-tracker/`.

If a reusable helper would cross extension boundaries, put it in `.pi/extensions/_shared/` rather than importing another extension’s internals.
