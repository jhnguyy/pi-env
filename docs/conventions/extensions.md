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

## Settings boundary

Use `.pi/extensions/_shared/settings.ts` as the single settings boundary. It owns path resolution, file IO, JSON/root validation, missing-file semantics, shallow overlay precedence, and Effect Schema decode.

Settings paths are:

- global: `getAgentDir()/settings.json`
- project: `<cwd>/.pi/settings.json`

Missing files are absent empty layers. `loadSettingsSnapshotEffect` records `exists.global` and `exists.project`, so callers can distinguish both-missing from an existing empty `{}` without probing or rereading files. Non-`ENOENT` read failures fail as `SettingsReadError` with exact `source` and `path`. Malformed JSON and non-object JSON roots fail as `SettingsDecodeError` with exact local `source` and `path`.

Overlay order is global then project with shallow replacement only. `readSettingsBlock(key)` overlays matching keys inside that block; nested objects are replaced, not deep-merged. Whole agent settings overlay top-level keys the same way.

Schema decoding should happen once at the consumer boundary with `decodeSettingsBlockEffect`/`decodeSettingsBlockSync` or a snapshot decode helper. Block schema failures are overlay errors that include the block `key` and both participating paths; JSON/root failures remain exact-source local errors. Compatibility sync wrappers may throw these typed errors and should be allowed to reach existing rendering boundaries.

Agent settings use Effect Schema for `enabledModels`, `modelAnnotations`, `workTracker` (`repos`/`protectedBranches`), and `extensions`. Required reads return typed settings errors. Optional reads return `null` only when both files are missing, and continue to recover to `null` on malformed/invalid settings for subagent/work-tracker behavior while using a single snapshot load.

## Cross-extension singletons

Store shared services on `globalThis`, not at module level. Module-level variables are per-bundle; `globalThis` is process-wide.

Hide the global behind a small registry/helper module and expose explicit test reset hooks when tests need isolation. Do not make tests delete global keys directly.
