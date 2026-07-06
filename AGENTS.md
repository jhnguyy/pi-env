# AGENTS.md

## JavaScript Tooling

Prefer `nub` over `node`, `bun`, `npm`, `npx`, `pnpm`, and `yarn`: run files with `nub <file>`, scripts with `nub run <script>`, local CLIs with `nubx <tool>`, and installs with `nub install` / `nub add`. Use `nub --node <file>` only when strict, unaugmented Node behavior is required.

## Code-Quality Harness

Before writing any new function, search the repo for an existing one. State what you searched and found.

Run `nub run check:all` before considering any code task complete. Use `nub run harness:report` for actionable findings and `nub run harness:files` to see harness-owned config/scripts.

Canonical locations are source-of-truth files, not prose:

- Harness checks: `.dependency-cruiser.cjs`, `.jscpd.json`, `knip.json`, `scripts/check-*.{js,sh}`, `scripts/run-jscpd.js`.
- Agent feedback loop: `.pi/extensions/dev-tools/agent-end-pipeline.ts`, `agent-end-review.ts`.
- Shared extension helpers: `.pi/extensions/_shared/`.
- Extension conventions: `docs/conventions/extensions.md`.

If reusable code would cross extension boundaries, put it in `.pi/extensions/_shared/` rather than importing another extension’s internals.
