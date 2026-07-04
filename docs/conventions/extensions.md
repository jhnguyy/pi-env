# Extension conventions

## Runtime shape

Extensions compile to `dist/index.js` Node ESM bundles for fast load times. Source files in `.pi/extensions/*/` are never loaded directly by pi at runtime.

Each active extension should have:

1. `.pi/extensions/<name>/index.ts` with the default export
2. `.pi/extensions/<name>/package.json` with name `@pi-env/<name>` and `"type": "module"`
3. `.pi/extensions/<name>` in both `package.json#workspaces` and `package.json#pi.extensions`
4. at least one `__tests__/*.test.ts` file

## Lifecycle contract

Use `scripts/extension-manifest.mjs` as the shared lifecycle contract. It normalizes package paths, source entries, runtime bundles, sidecars, default-disabled state, workspace membership, and active extension sets for build, cleanup, and install verification.

`pi-build.config.json` holds build-only details such as external packages and sidecar bundles. Pi peer packages are externalized so the runtime copies provided by pi are used instead of bundled duplicates.

Use `package.json` scripts as the source of truth for build, test, cleanup, and verification commands.

The build runs during `nub install`/setup via `postinstall` plus an explicit setup build step. Install/setup intentionally does not run the full test suite; it stays focused on making the local Pi environment current without burning CPU on routine pulls.

## Tool output shape

Keep tools context-economical:

- prefer compact navigation/metadata outputs first
- use opt-in detail views for larger data
- never return raw generated artifacts, large logs, or full session JSONL unless that is explicitly the tool's purpose and truncation is enforced

## Cross-extension singletons

Store shared services on `globalThis`, not at module level. Module-level variables are per-bundle; `globalThis` is process-wide.
