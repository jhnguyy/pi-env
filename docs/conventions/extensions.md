# Extension conventions

## Runtime shape

Extensions compile to `dist/index.js` Node ESM bundles for fast load times. Pi never loads source files in `.pi/extensions/*/` directly at runtime.

Each active extension should have:

1. `.pi/extensions/<name>/index.ts` with the default export
2. `.pi/extensions/<name>/package.json` with name `@pi-env/<name>` and `"type": "module"`
3. `.pi/extensions/<name>` in both `package.json#workspaces` and `package.json#pi.extensions`
4. at least one `__tests__/*.test.ts` file

## Lifecycle contract

Use `scripts/extension-manifest.mjs` as the shared lifecycle contract. It normalizes package paths, source entries, runtime bundles, sidecars, default-disabled state, workspace membership, and active extension sets for build, cleanup, and install verification.

`pi-build.config.json` holds build-only details such as external packages and sidecar bundles. Pi peer packages are externalized so the runtime copies provided by pi are used instead of bundled duplicates.

Use `package.json` scripts as the source of truth for build, test, cleanup, and verification commands.

The build runs during `nub install` or setup via `postinstall` plus an explicit setup build step. Install/setup intentionally does not run the full test suite. It stays focused on making the local Pi environment current without burning CPU on routine pulls.

## Tool output shape

Keep tool output context-economical:

- Prefer compact navigation and metadata outputs first.
- Use opt-in detail views for larger data.
- Never return raw generated artifacts, large logs, or full session JSONL unless that is explicitly the tool's purpose and truncation is enforced.

## Settings boundary

Use `.pi/extensions/_shared/settings.ts` as the single settings boundary. It owns path resolution, file IO, JSON/root validation, missing-file semantics, shallow overlay precedence, and Effect Schema decode.

Settings paths are:

- global: `getAgentDir()/settings.json`
- project: `<cwd>/.pi/settings.json`

Missing files are absent empty layers. `loadSettingsSnapshotEffect` records `exists.global` and `exists.project`, so callers can distinguish both-missing from an existing empty `{}` without probing or rereading files. Non-`ENOENT` read failures fail as `SettingsReadError` with exact `source` and `path`. Malformed JSON and non-object JSON roots fail as `SettingsDecodeError` with exact local `source` and `path`.

Overlay order is global then project with shallow replacement only. `readSettingsBlock(key)` overlays matching keys inside that block. Nested objects are replaced, not deep-merged. Whole agent settings overlay top-level keys the same way.

Schema decoding should happen once at the consumer boundary with `decodeSettingsBlockEffect`/`decodeSettingsBlockSync` or a snapshot decode helper. Block schema failures are overlay errors that include the block `key` and both participating paths. JSON or root failures remain exact-source local errors. Compatibility sync wrappers may throw these typed errors. Let them reach existing rendering boundaries.

Agent settings use Effect Schema for `enabledModels`, `modelAnnotations`, `workTracker` (`repos` and `protectedBranches`), and `extensions`. The subagent extension decodes its `subagent` resource-limit block at the consumer boundary. Required reads return typed settings errors. Optional reads return `null` only when both files are missing. They continue to recover to `null` on malformed or invalid settings for subagent and work-tracker behavior while using a single snapshot load.

## Cross-host tool registration

Generally reusable tools that should behave the same in Pi and AgentTool hosts should register through `.pi/extensions/_shared/register-cross-host-tool.ts` via the canonical shape:

```ts
registerCrossHostTool(pi, {
  contract,
  capabilities: [ToolCapability.Read],
  piOptions: {
    promptSnippet,
    promptGuidelines,
    renderCall,
    renderResult,
  },
});
```

Use `jit_catch` as the canonical shared-contract example and `closeout` as the migrated example. Require a non-empty capability classification for every cross-host registration. Pi-only prompt and render metadata belong in `piOptions`; the shared contract remains host-neutral.

Runtime behavior is defined by the helper and its tests: the main-session AgentTool uses the session `cwd`; child tools use `parentContext ?? { cwd }`; cancellation signals and progress updates forward through both adapters; and AgentTool registration automatically exposes eligible tools to subagents and PTC, subject to the PTC blocklist in `.pi/extensions/ptc/types.ts`.

Keep the lower-level helpers (`toPiTool`, `toAgentTool`, `registerAgentToolsOnSessionStart`) for main-only, run-scoped, or custom-context tools. If a generally reusable tool stays Pi-only, document an adjacent reason. Current run-scoped exceptions are `pr_review_start`, `subagent`, `subagent_start`, and `subagent_job`.

The public test boundary for shared cross-host tools is the helper contract in `.pi/extensions/__tests__/register-cross-host-tool.test.ts` plus representative tool coverage such as `.pi/extensions/jit-catch/__tests__/contract.test.ts`: schema identity, capabilities, cwd/context behavior, cancellation, progress, Pi-only metadata, and unregister lifecycle. Safety-sensitive descriptions must state side effects and operational boundaries.

## Cross-extension singletons

Store shared services on `globalThis`, not at module level. Module-level variables are per-bundle. `globalThis` is process-wide.

Hide the global behind a small registry or helper module. Expose explicit test reset hooks when tests need isolation. Do not make tests delete global keys directly.
