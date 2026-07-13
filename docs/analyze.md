# Analyze

> **Safe mode:** public Analyze uses a detached, bounded worker supervisor. The parent never loads the engine, TypeScript, or program implementation. Safe requests are diff scope or non-empty explicit paths with an explicit non-empty subset of `complexity,async-risk,duplicates`. Syntax inputs are capped at 1,024 files, 256 KiB per file, and 2 MiB total before parsing. `duplicates` compares only the selected diff/path corpus; use explicit path `.` for the bounded whole-source corpus.
>
> All scope, semantic type, eslint, dependency, knip, bundle, benchmark, profiling, and `all` requests require strict OS containment. This runtime has no strict containment adapter, so those requests are refused before a worker is spawned. A process group and heap flag are cleanup limits, not containment.

Safe examples:

```sh
nub run analyze -- --diff --checks complexity,async-risk
nub run analyze -- --checks complexity src/analyze/policy.ts
nub run analyze -- --checks duplicates .
```

`check:quality` is intentionally absent from normal and safe verification plans until strict containment exists. Use source-owned verification scripts instead:

- [`package.json#scripts`](../package.json)
- [`scripts/verification-plan.mjs`](../scripts/verification-plan.mjs)
- [`scripts/safe-verification-plan.mjs`](../scripts/safe-verification-plan.mjs)
- [`scripts/verification-phases.mjs`](../scripts/verification-phases.mjs)

## Containment rationale

Process groups guarantee descendant cleanup but are not aggregate memory/PID containment. Node old-space limits do not cover every native/external allocation. Safe syntax budgets are portable workload bounds for a stable local worktree, not a filesystem security sandbox against concurrent mutation. Strict requests therefore remain unavailable until a real cgroup/container/job adapter enforces aggregate limits.

Async-risk findings about sequential awaits are review signals, not automatic defects: benchmark runs, analyzer stages, and bundle entries may intentionally remain sequential where concurrency would distort measurements or increase peak memory.

## User-facing configuration

OTLP trace export is off by default. Enabling it requires both:

```sh
PI_ENV_ANALYZE_OTEL_ENABLED=true
PI_ENV_ANALYZE_OTEL_ENDPOINT=http://collector:4318
```

The endpoint is never emitted as telemetry.

The supervisor writes a bounded NDJSON journal under `$XDG_STATE_HOME/pi-env/analyze` (or `~/.local/state/pi-env/analyze`; override with `PI_ENV_ANALYZE_JOURNAL_DIR`). Set `PI_ENV_ANALYZE_JOURNAL_ENABLED=false` to disable it.

## Source navigation

- CLI entrypoint: [`scripts/analyze.ts`](../scripts/analyze.ts)
- Public boundary: [`src/analyze/public.ts`](../src/analyze/public.ts)
- Policy and containment decisions: [`src/analyze/policy.ts`](../src/analyze/policy.ts), [`src/analyze/containment.ts`](../src/analyze/containment.ts)
- Supervisor and protocol: [`src/analyze/supervisor.ts`](../src/analyze/supervisor.ts), [`src/analyze/protocol.ts`](../src/analyze/protocol.ts)
- Diagnostics, journal, telemetry: [`src/analyze/diagnostics.ts`](../src/analyze/diagnostics.ts), [`src/analyze/journal.ts`](../src/analyze/journal.ts), [`src/analyze/otel.ts`](../src/analyze/otel.ts)
- Analyze extension: [`.pi/extensions/analyze`](../.pi/extensions/analyze)
