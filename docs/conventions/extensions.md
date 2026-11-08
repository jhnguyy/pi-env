# Extension conventions

## Runtime shape

Extensions compile to `dist/index.js` Node ESM bundles for fast load times. Pi never loads source files in `extensions/*/` directly at runtime.

Pi loads this repository's extensions, skills, and themes only through [`package.json#pi`](../../package.json) once setup registers the checkout. Keep shipped resources out of `.pi/` and `.agents/`: Pi auto-discovers those in any trusted project, so every worktree would load a second copy beside the registered package.

Each active extension should have:

1. `extensions/<name>/index.ts` with the default export
2. `extensions/<name>/package.json` with name `@pi-env/<name>` and `"type": "module"`
3. `extensions/<name>` in both `package.json#workspaces` and `package.json#pi.extensions`

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

Register each model-facing Pi tool through `extensions/_shared/tool-render.ts` or a shared registration helper that uses it. Each public tool must provide its complete model-facing `description`, a compact `renderCall`, and a `renderResult` for collapsed and expanded output. Run-scoped native `ToolDefinition` values do not own parent transcript rows and do not need these renderers.

Use the shared short-description helper for compact prose. Its default limit is 70 content characters plus `...`. Keep the source text unchanged for expanded output. Apply ANSI-safe viewport truncation at the component render boundary.

Thread the host's injected `KeybindingHints` through renderer helpers: tool renderers receive them in `context`, and message/entry renderers in `options`. Derive tool-render boundary types from Pi's native callback context and `ToolRenderResultOptions`, selecting only the fields consumed or forwarded. Pi 1.5 does not re-export `ToolRenderContext`; the shared `NativeToolRenderContext` derives it from `ToolDefinition["renderResult"]`. Use `context.isError`, not a field on the host's `{ content, details }` result. Leaf helpers that only format hints can depend on `KeybindingHints`. Helpers that use or forward context must require it, including direct callers and test fixtures. Do not import global `keyHint`/`keyText` or substitute a default key: a bundled package copy may not share the host's bindings. An empty `keyText("app.tools.expand")` means the binding is disabled; omit the hint and its decoration without calling `keyHint`.

For inline custom dialogs that wait for an answer, follow upstream [custom screens and overlays](https://pi.dev/docs/tui#use-custom-screens-and-overlays) and set `blocked`. Overlays ignore that option; the `/subagents` overlay does not need it.

## Settings boundary

Use `extensions/_shared/settings.ts` as the single settings boundary. It owns path resolution, file IO, JSON/root validation, missing-file semantics, shallow overlay precedence, and Effect Schema decode.

Settings paths are:

- global: `getAgentDir()/settings.json`
- project: `<cwd>/.pi/settings.json`

Missing files are absent empty layers. `loadSettingsSnapshotEffect` records `exists.global` and `exists.project`, so callers can distinguish both-missing from an existing empty `{}` without probing or rereading files. Non-`ENOENT` read failures fail as `SettingsReadError` with exact `source` and `path`. Malformed JSON and non-object JSON roots fail as `SettingsDecodeError` with exact local `source` and `path`.

Overlay order is global then project with shallow replacement only. `readSettingsBlock(key)` overlays matching keys inside that block. Nested objects are replaced, not deep-merged. Whole agent settings overlay top-level keys the same way.

Schema decoding should happen once at the consumer boundary with `decodeSettingsBlockEffect`/`decodeSettingsBlockSync` or a snapshot decode helper. Block schema failures are overlay errors that include the block `key` and both participating paths. JSON or root failures remain exact-source local errors. Compatibility sync wrappers may throw these typed errors. Let them reach existing rendering boundaries.

Agent settings use Effect Schema for `modelAnnotations`, `workTracker` (`repos` and `protectedBranches`), and `extensions`. Pi owns model availability and native model-selection settings. [Subagents](../subagents.md) own their advertised model roster. Model annotations are descriptive selection guidance, not approval tags or delegation permissions. The subagent extension decodes its `subagent` settings block at the consumer boundary. Required reads return typed settings errors. Optional reads return `null` only when both files are missing. They continue to recover to `null` on malformed or invalid settings for subagent and work-tracker behavior while using a single snapshot load.

## Native tool registration

Use native Pi registration for public tools. When a domain contract needs the shared cwd, cancellation, and progress adapter, use [registerContractTool](../../extensions/_shared/register-contract-tool.ts):

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

Import schema builders and types from `typebox` in library and bundled code. Pi's extension loader maps `@earendil-works/pi-ai` to a compatibility entry that also supplies TypeBox, but ordinary Node imports do not use that mapping. Use native `Type.Enum(values, { type: "string", ...annotations })` for string enums to preserve literal inference and a provider-compatible flat enum. Do not depend on loader-only exports or private compatibility paths.

Pi validates tool arguments as JSON Schema, not through TypeBox-specific refinements, codecs, or format registries. Keep non-JSON-Schema constraints at execution boundaries. See upstream [tool parameter schemas and TypeBox](https://pi.dev/docs/extensions#tool-parameter-schemas-and-typebox) for coercion and validation semantics.

Declare `parameters` as one top-level object. Some provider adapters, including Pi's Anthropic adapter, send only top-level `properties` and `required`, so a top-level union reaches the model as an empty object. Check per-action combinations at execution, as the [notes contract](../../extensions/notes/contract.ts) does.

The helper registers one native tool. It does not publish a second AgentTool or maintain a process-wide tool catalog. Host-independent contract types live in [domain-tool.ts](../../extensions/_shared/domain-tool.ts); [toPiTool](../../extensions/_shared/tool-contract.ts) adapts them into native definitions. Native execution supplies each invocation's cwd, signal, and progress callback. Keep host-specific configuration, rendering, and output limits outside shared domain execution; [notes](../notes.md) also exposes a durable entry point.

Pass run-private definitions through `ResolvedSubagentRun.customTools` at the [native execution entrypoint](../../extensions/subagent/execute.ts). Select their names with `toolNames`; an explicit empty selection enables no tools. Do not publish run-bound callbacks globally. Native child sessions load ordinary extensions and receive only their run's supplied definitions.

Use the [tool adapter tests](../../extensions/__tests__/tool-contract.test.ts) for invocation context, cancellation, and progress, and representative native tool tests, such as [closeout](../../extensions/dev-tools/__tests__/closeout.integration.test.ts), for execution behavior. State side effects and operational limits in safety-sensitive descriptions.

[Child creation context](../../extensions/_shared/child-context.ts) identifies target cwd and agentDir across native loading and independently bundled extensions. Root orchestration factories return early in that scope. Do not change process cwd or environment variables to identify a child.

## Cross-extension singletons

Store shared services on `globalThis`, not at module level. Module-level variables are per-bundle. `globalThis` is process-wide.

Hide the global behind a small registry or helper module. Expose explicit test reset hooks when tests need isolation. Do not make tests delete global keys directly.
