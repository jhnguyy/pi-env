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

## Post-edit sensors

Use the `dev-tools` agent-end pipeline as the shared post-edit feedback loop for code sensors. Sensor output should lead with review-readiness metadata — checked files, skipped files, backends, and issue counts — before detailed findings. The follow-up message should tell the agent whether to keep fixing, justify warnings, or confirm that the change is ready for review.

Project-specific external sensors can be configured with `.pi/code-sensors.json` when a repo is ready to opt in:

```json
{
  "version": 1,
  "sensors": [
    {
      "name": "dependency-cruiser",
      "command": "nubx depcruise src",
      "include": [".ts", ".tsx"],
      "timeoutMs": 120000,
      "severity": "error"
    }
  ]
}
```

Keep commands deterministic and local to the repository. Prefer buying mature analyzers such as dependency-cruiser, jscpd, knip, and Semgrep; the pi-env code should only own config loading, diff/file scoping, and agent-readable result formatting.

For pi-env itself, use `nub run check:all` as the combined harness entry point and `nub run harness:report` when you want the same checks rendered as agent-actionable instructions.

## Cross-extension singletons

Store shared services on `globalThis`, not at module level. Module-level variables are per-bundle; `globalThis` is process-wide.

Hide the global behind a small registry/helper module and expose explicit test reset hooks when tests need isolation. Do not make tests delete global keys directly.
