# Extension conventions

## Runtime shape

Extensions compile to `dist/index.js` Node ESM bundles for fast load times. Pi never loads source files in `.pi/extensions/*/` directly at runtime.

Each active extension should have:

1. `.pi/extensions/<name>/index.ts` with the default export
2. `.pi/extensions/<name>/package.json` with name `@pi-env/<name>` and `"type": "module"`
3. `.pi/extensions/<name>` in both `package.json#workspaces` and `package.json#pi.extensions`

Add permanent tests only when they protect a capability, regression, or safety invariant. Do not require a test file only to satisfy an extension layout rule.

## Lifecycle contract

Use `scripts/extension-manifest.mjs` as the shared lifecycle contract. It normalizes package paths, source entries, runtime bundles, sidecars, default-disabled state, workspace membership, and active extension sets for build, cleanup, and install verification.

`pi-build.config.json` holds build-only details such as external packages and sidecar bundles. Pi peer packages are externalized so the runtime copies provided by pi are used instead of bundled duplicates.

Use `package.json` scripts as the source of truth for build, test, cleanup, and verification commands.

[Repository hydration](../../scripts/hydrate.mjs) owns install-time artifact preparation. See the [setup integration](../setup.md#runtime-integration) rather than duplicating its sequencing here. Install/setup does not run the full verification portfolio.

## Tool output shape

Keep tool output context-economical:

- Prefer compact navigation and metadata outputs first.
- Use opt-in detail views for larger data.
- Never return raw generated artifacts, large logs, or full session JSONL unless that is explicitly the tool's purpose and truncation is enforced.

Register each model-facing Pi tool through `.pi/extensions/_shared/tool-render.ts` or a shared registration helper that uses it. Each public tool must provide its complete model-facing `description`, a compact `renderCall`, and a `renderResult` for collapsed and expanded output. Run-scoped native `ToolDefinition` values do not own parent transcript rows and do not need these renderers.

Use the shared short-description helper for compact prose. Its default limit is 70 content characters plus `...`. Keep the source text unchanged for expanded output. Apply ANSI-safe viewport truncation at the component render boundary.

## Settings boundary

Use `.pi/extensions/_shared/settings.ts` as the single settings boundary. It owns path resolution, file IO, JSON/root validation, missing-file semantics, shallow overlay precedence, and Effect Schema decode.

Settings paths are:

- global: `getAgentDir()/settings.json`
- project: `<cwd>/.pi/settings.json`

Missing files are absent empty layers. `loadSettingsSnapshotEffect` records `exists.global` and `exists.project`, so callers can distinguish both-missing from an existing empty `{}` without probing or rereading files. Non-`ENOENT` read failures fail as `SettingsReadError` with exact `source` and `path`. Malformed JSON and non-object JSON roots fail as `SettingsDecodeError` with exact local `source` and `path`.

Overlay order is global then project with shallow replacement only. `readSettingsBlock(key)` overlays matching keys inside that block. Nested objects are replaced, not deep-merged. Whole agent settings overlay top-level keys the same way.

Schema decoding should happen once at the consumer boundary with `decodeSettingsBlockEffect`/`decodeSettingsBlockSync` or a snapshot decode helper. Block schema failures are overlay errors that include the block `key` and both participating paths. JSON or root failures remain exact-source local errors. Compatibility sync wrappers may throw these typed errors. Let them reach existing rendering boundaries.

Agent settings use Effect Schema for `modelAnnotations`, `workTracker` (`repos` and `protectedBranches`), and `extensions`. Pi owns model availability and native model-selection settings. Subagents advertise the complete available registry roster. Model annotations are descriptive selection guidance, not approval tags or delegation permissions. The subagent extension decodes its `subagent` settings block at the consumer boundary. Required reads return typed settings errors. Optional reads return `null` only when both files are missing. They continue to recover to `null` on malformed or invalid settings for subagent and work-tracker behavior while using a single snapshot load.

## Native tool registration

Use native Pi registration for public tools. When a domain contract needs the shared cwd, cancellation, and progress adapter, use [registerContractTool](../../.pi/extensions/_shared/register-contract-tool.ts):

```ts
registerContractTool(pi, {
  contract,
  piOptions: {
    promptSnippet,
    promptGuidelines,
    renderCall,
    renderResult,
  },
});
```

The helper registers one native tool. It does not publish a second AgentTool or maintain a process-wide tool catalog. [toPiTool](../../.pi/extensions/_shared/tool-contract.ts) adapts contracts into native definitions. Native execution supplies each invocation's cwd, signal, and progress callback.

Pass review-private definitions through the existing [DAG submission authority](../../.pi/extensions/_shared/dag-runtime-service.ts). Do not publish run-bound callbacks globally or serialize functions into graph artifacts. Native child sessions load ordinary extensions and receive only their run's supplied definitions.

Use the [registration contract test](../../.pi/extensions/__tests__/register-contract-tool.test.ts) and representative native tool tests, such as [closeout](../../.pi/extensions/dev-tools/__tests__/closeout.integration.test.ts), for schema, context, cancellation, progress, and rendering metadata. State side effects and operational limits in safety-sensitive descriptions.

[Child creation context](../../.pi/extensions/_shared/child-context.ts) identifies target cwd and agentDir across native loading and independently bundled extensions. Root orchestration factories return early in that scope. Do not change process cwd or environment variables to identify a child.

## Cross-extension singletons

Store shared services on `globalThis`, not at module level. Module-level variables are per-bundle. `globalThis` is process-wide.

Hide the global behind a small registry or helper module. Expose explicit test reset hooks when tests need isolation. Do not make tests delete global keys directly.
