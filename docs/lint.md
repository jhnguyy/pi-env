# Linting

Lint profiles separate work that operates on one file from work that builds cross-module or type information.

| Command                | Capability                                                                            | Configuration            |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------ |
| `nub run lint:syntax`  | Native file-local rules and custom JS rules, including same-file scope/alias analysis | `.oxlintrc-syntax.json`  |
| `nub run lint:imports` | Import resolution and cross-module analysis                                           | `.oxlintrc-imports.json` |
| `nub run lint:types`   | Type-aware lint rules using the native TypeScript backend                             | `.oxlintrc-types.json`   |
| `nub run lint`         | All three profiles, sequentially, stopping at the first failure                       | All three                |

With no paths, commands scan the repository. Supply paths to narrow diagnostics:

```bash
nub run lint:syntax src/analyze/policy.ts
nub run lint:imports src/analyze/policy.ts
nub run lint:types src/analyze/policy.ts
```

A narrow target does not guarantee a small import graph or TypeScript program. Run import and typed profiles with adequate capacity. Each invocation uses one Oxlint worker, the existing process supervisor, and the shared heavyweight lock; these controls do not establish a process-tree memory limit.

Full lint runs each capability in a fresh process so import graphs and custom-plugin state can be released before type-aware analysis. This deliberately reparses sources rather than keeping all three capabilities resident together. Run an individual profile to inspect its findings after an earlier profile fails or to collect structured output; the aggregate command does not merge reports. `lint:type` remains an alias for full lint coverage, rather than changing into a typed-only check.

## Configuration ownership

Each rule belongs to one capability profile. `.oxlintrc-base.json` disables implicit rule categories and plugins; profiles explicitly select the plugins they need. Enabling the import plugin activates cross-module processing even when its individual rules are disabled, so it belongs only in the imports profile. Entry configurations declare their own ignores rather than relying on `extends` to propagate file-selection policy.

`.oxlintrc.json` composes the profiles for compatibility with direct Oxlint invocation, editor integration, and Analyze's existing `eslint` backend. It preserves the combined rule policy; type-aware rules still require `--type-aware`. That combined path can retain multiple capabilities at once and does not receive the separated commands' memory benefit.

## Routine verification

[Contribution guidance](../CONTRIBUTING.md#verification) owns routine verification. Its native sensor profile and source-pattern checks remain separate from full lint, with their existing scope and warning policy. Sensor commands use the shared shell driver directly rather than recursively dispatching package scripts. Verification, pattern checks, and supervised lint entrypoints use the existing Node runner to select and validate the application runtime. Native Oxlint launchers still use the host-Node runner because their children need a directly executable Node. Verification planning loads the process supervisor only for commands that need it; inspecting a plan does not load the Effect-backed process runtime.
