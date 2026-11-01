# Analyze

Analyze provides targeted syntax evidence for code review. Its findings help locate repeated work and structurally similar implementations or tests; they do not establish that code is defective or that one test can safely replace another.

## Choose a useful scope

Start with the change or a small set of relevant paths:

```sh
nub run analyze --diff --checks async-risk
nub run analyze --checks duplicates src/analyze/policy.ts
nub run analyze --checks test-duplicates .pi/extensions/review/__tests__
```

Diff scope can use a comparison ref; explicit paths describe a separate scope. Directory paths expand the selected corpus, so even a bounded request can be broader than useful feedback requires. Duplicate analysis compares only the selected corpus: absence of a finding is not evidence that no similar code exists elsewhere.

`async-risk` looks for repeated scans inside loops. `duplicates` examines production code; `test-duplicates` examines test callback bodies, including parameterized and modifier forms. A structural match is a candidate for investigation, not proof of equivalent requirements. Similar tests may protect different boundaries, while expensive shared setup may be worth improving without removing any assertions.

## Understand the safety boundary

The public entrypoint admits bounded syntax requests to a supervised worker. Workload limits apply before parsing as well as to worker execution and output; [the policy](../src/analyze/policy.ts) owns the supported capabilities and current limits.

Requests needing semantic type analysis, external analyzers, profiling, or other strict capabilities are refused because this runtime has no strict OS-containment adapter. A package script that requests one of those capabilities does not bypass that restriction. In particular, broad `all` scope is different from a directory path selected for bounded syntax analysis.

Process-group signalling helps stop members of the owned group, but cannot guarantee control of descendants that detach from it. Node heap limits do not cover all native or external allocations. Neither mechanism provides an aggregate memory or process boundary. The syntax budgets also do not make a changing worktree a filesystem security sandbox.

Treat a refused request as a missing operating capability, not a reason to bypass the public boundary. Strict work needs an environment that can enforce the aggregate limits it relies on.

## Interpret signals in context

Oxlint owns the repository's complexity and await-in-loop sensors; [its configuration](../.oxlintrc-sensors.json) defines their scope and thresholds. `nub run lint:sensors <paths>` reports those signals without asking Analyze to load a type program. [Contribution guidance](../CONTRIBUTING.md#verification) explains how they participate in verification.

An await inside a loop may preserve ordering, bound resource use, or keep a benchmark meaningful. Investigate the work and its constraints before changing concurrency. When a warning is intentionally suppressed, explain that constraint at the relevant operation rather than merely restating the warning.

Likewise, investigate a duplicate-test finding by comparing the failure each scenario exposes. Shared syntax, setup, or assertions are not enough to justify pruning safety coverage. See [testing guidance](conventions/testing.md) for that judgment.

## Diagnostics and privacy

The supervisor keeps a bounded local NDJSON journal under `$XDG_STATE_HOME/pi-env/analyze`, or `~/.local/state/pi-env/analyze` when that variable is absent. Use `PI_ENV_ANALYZE_JOURNAL_DIR` to choose another location or `PI_ENV_ANALYZE_JOURNAL_ENABLED=false` to disable it. Preserve relevant failure evidence before rerunning work that may replace it, and review diagnostic files before sharing them.

OTLP trace export is off by default. Enable it by setting both `PI_ENV_ANALYZE_OTEL_ENABLED=true` and `PI_ENV_ANALYZE_OTEL_ENDPOINT` to the intended collector. The endpoint is not emitted as telemetry.

## Maintaining Analyze

The [CLI](../scripts/analyze.ts) and [public boundary](../src/analyze/public.ts) connect requests to the [policy](../src/analyze/policy.ts) and [supervisor](../src/analyze/supervisor.ts). The [syntax project loader](../src/analyze/program.ts) and [analyzers](../src/analyze/analyzers.ts) define the evidence produced. Keep operating guidance focused on interpreting that evidence and its limits rather than duplicating their implementation.
