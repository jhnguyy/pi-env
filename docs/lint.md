# Linting

Use `nub run lint` for full lint qualification. It runs file-local, import-graph, and typed checks in separate sequential processes, releasing each capability's state before the next starts. This reduces overlapping memory use at the cost of reparsing sources. Execution stops at the first failure.

For focused diagnostics or structured output, select `lint:syntax`, `lint:imports`, or `lint:types` and pass paths, for example:

```bash
nub run lint:syntax src/analyze/policy.ts
```

Oxlint owns rules, plugins, type-aware activation, and file eligibility. Common exclusions live in its native `.eslintignore`; capability-specific policy stays in the corresponding configuration. The launcher selects and sequences profiles under the existing runtime selector, process supervisor, and heavyweight lock. A narrow target or one Oxlint worker does not establish a process-tree memory bound.

`.oxlintrc.json` composes the rule profiles for direct invocation, editors, and Analyze's existing backend. That combined path retains multiple capabilities together; typed checks require `--type-aware`. `lint:type` remains an alias for full lint coverage. The sequential command does not merge profiles' structured reports.

[Contribution guidance](../CONTRIBUTING.md#verification) owns routine verification, whose sensor and source-pattern scopes remain narrower than full qualification.
