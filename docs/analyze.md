# Analyze

> **Safe mode:** public Analyze uses a detached, bounded worker supervisor. The parent never loads the engine, TypeScript, or program implementation. Safe requests are diff scope or non-empty explicit paths with an explicit non-empty subset of `complexity,async-risk,duplicates`. Syntax inputs are capped at 1,024 files, 256 KiB per file, and 2 MiB total before parsing. `duplicates` compares only the selected diff/path corpus; use explicit path `.` for the bounded whole-source corpus.
>
> All scope, semantic type, eslint, dependency, knip, bundle, benchmark, and profiling requests require strict OS containment. This runtime has no strict containment adapter, so those requests are refused before a worker is spawned. A process group and heap flag are cleanup limits, not containment.

Safe examples:

```sh
nub run analyze -- --diff --checks complexity,async-risk
nub run analyze -- --checks complexity src/analyze/policy.ts
nub run analyze -- --checks duplicates .
```

Use the analyzer-free validation lane:

```sh
nub run format:check
nub run typecheck
nub run lint:type
nub run test:safe
nub run build
nub run check:patterns
nub run verify:install
```

`check:quality` is intentionally absent from normal and safe verification plans until strict containment exists.

The implementation below documents the worker-only engine contract retained for hardening. Public CLI and Pi adapters import only the policy and supervisor boundary; the engine, program builder, and TypeScript compiler are bundled only into the isolated worker sidecar.

Internal analyzers request the least expensive shared project capability they need. Complexity, async-risk, and duplicates parse only the selected bounded source corpus; duplicate canonical text is hashed and discarded rather than retained per candidate. Type similarity upgrades the shared project to a TypeScript Program/TypeChecker. The v1 `eslint` check name is retained, but is implemented by type-aware Oxlint plus `oxlint-tsgolint`; `.oxlintrc.json` enables only `typescript/no-floating-promises`, `typescript/no-misused-promises`, and `typescript/await-thenable`. Oxlint is run with JSON output, one thread, and sequential path batches (without `--type-check`); its diagnostics are normalized to the existing `@typescript-eslint/*` rule IDs. Dependency-cruiser uses JSON output. Knip headings are warning-level advisories; unstructured fallback output is explicitly labeled as a legacy adapter. Analyzer subprocesses use argument-array spawning without a shell and stream stdout/stderr into bounded sinks. Bundle analysis runs esbuild in an interruptible child, uses temporary on-disk output plus its metafile, and remains opt-in (`--bundle` or an explicit `bundle` check).

Result JSON is versioned. IDs include the analyzer, message, primary location, and related locations. Timings appear only with `--profile`. Analyzer and benchmark failures are retained alongside successful findings.

## Initial diagnostics and OpenTelemetry

The supervisor owns the single `analyze.run` root span, structured Effect logs, run/failure counters, duration metrics, memory gauges, and terminal outcome. The worker engine exposes an injected `AnalysisDiagnostics` seam for bounded preflight, scope, project-load, check, result, memory, and failure events. Worker telemetry export is disabled; sanitized non-terminal events cross the bounded protocol and are recorded by the parent.

OTLP trace export is off by default. Enabling it requires both:

```sh
PI_ENV_ANALYZE_OTEL_ENABLED=true
PI_ENV_ANALYZE_OTEL_ENDPOINT=http://collector:4318
```

The endpoint is never emitted as telemetry. Export uses a queue of at most 64 spans, batches of at most 16, and three-second export/shutdown limits. Attributes use an allowlist and exclude source, prompts, findings text, raw commands/output, environment values, tokens, tsconfig contents, and full paths.

The supervisor writes a bounded NDJSON journal under `$XDG_STATE_HOME/pi-env/analyze` (or `~/.local/state/pi-env/analyze`; override with `PI_ENV_ANALYZE_JOURNAL_DIR`). Journal writes are enabled by default, rotate by file/count/age/aggregate bytes, flush periodically and at terminal events, recover complete records before a partial crash line, and disable permanently after one write-boundary failure. Set `PI_ENV_ANALYZE_JOURNAL_ENABLED=false` to disable it. Each supervised run synthesizes exactly one terminal event; retention remains bounded rather than guaranteeing indefinite preservation of every prior terminal record.

The active versioned worker protocol enforces `started → diagnostic* → result → complete`, stable run identity, line/aggregate byte limits, bounded request/result fields, trusted relative finding locations, and rejection of malformed, wrong-version, out-of-order, duplicate, or post-terminal messages.

## Effect and cancellation boundaries

`analyzeEffect` is the typed core: configuration, scope, and project setup failures remain in its Effect error channel. `analyze` is the reporting boundary and exhaustively converts those errors into the existing `AnalysisResult` failure shape. Analyzer dispatch catches synchronous analyzer and parser exceptions as typed `AnalyzerRunError` values; external analyzer and benchmark failures are captured individually so earlier findings and benchmark records survive.

Git scope discovery and explicit path walking are asynchronous Effect boundaries. Git children are interrupted with their fibers, filesystem walks yield between directories, and internal analyzers yield between files (and type seeds) while preserving deterministic sequential accumulation. One pathological source file can still occupy a checkpoint interval.

Oxlint, dependency-cruiser, Knip, and bundle workers use a bounded streaming subprocess Effect seam. It aborts child processes on fiber interruption, rejects stdout/stderr that exceed their byte limits, and uses explicit defaults (120 seconds for analyzers, 30 seconds for benchmark commands); timeout, output-limit, and process-exit failures are typed. Node-backed analyzer children inherit the environment and receive a conservative heap cap based on remaining budget after parent RSS and 512 MiB headroom, capped at 1024 MiB; existing `NODE_OPTIONS` are preserved. Oxlint's JavaScript launcher starts native workers and is run with a directly executable host Node so child processes do not inherit Nub's dynamic-loader `process.execPath`; it is deliberately not given a synthetic `NODE_OPTIONS` heap cap. Bundle workers process one entrypoint each, clean temporary output in `finally`, and are interrupted or timed out as whole processes.

## Memory-bounded operation (4 GB hosts)

Analysis resolves scope and checks before loading TypeScript. A declarative analyzer registry plans one shared project capability: bounded scoped syntax for complexity, async-risk, and duplicates, or a semantic Program/TypeChecker when type similarity is selected. Explicit safe scopes are loaded directly instead of enumerating the full tsconfig corpus. The project is released before external tools run. Oxlint discovers the project's typed tsconfig configuration and receives scoped filenames directly from tsconfig.

RSS guards default to 2048 MiB (`--max-memory-mb`, a positive integer). Before scope/project capability loading or analyzer child dispatch, each selected analyzer is preflighted against its declarative minimum total budget. An insufficient budget produces a structured failure for that analyzer only; it is skipped while other selected analyzers that meet their own budget still run. Conservative observed-run minima are: bounded syntax (complexity, async-risk, and duplicates) 512 MiB, semantic types 1024 MiB, type-aware Oxlint (`eslint`) 1536 MiB, and dependencies, Knip, and bundle 768 MiB. Runtime guards run around analyzers and before every bundle entry. If crossed, the result contains an analyzer failure, keeps completed findings, and skips remaining expensive work. These checks are guards, not an OS memory guarantee, and they do not measure or guarantee full process-tree RSS.

Unbounded `all` scope, bundle, semantic type, and external-tool analysis are currently unavailable through public adapters because this runtime cannot establish strict aggregate containment. Such requests return a structured `containment` refusal before any worker is spawned. The retained worker-only implementations remain sequential and bounded so they can be enabled later behind a real cgroup/container/job adapter. Async-risk findings about sequential awaits are review signals, not automatic defects: benchmark runs, analyzer stages, and bundle entries intentionally remain sequential where concurrency would distort measurements or increase peak memory. If the config is missing or invalid, the finding data records that no configured externals were available. `--profile` adds stage timings, memory snapshots, and peak RSS/heap/external values to JSON/results; these fields are omitted otherwise. Duplicate and type similarity candidate/comparison/finding limits are explicit, global finding materialization is capped, and truncation is reported informationally or through analyzer-failure metadata rather than silently dropped.

Public safe-mode defaults in this pass:

- isolated worker old-space cap: fixed at 512 MiB;
- safe checks: explicit non-empty subset of `complexity,async-risk,duplicates`;
- safe scopes: diff or at most 128 bounded workspace-relative paths, visiting at most 16,384 directory entries and expanding to at most 1,024 files;
- safe syntax source: at most 256 KiB per file and 2 MiB total before parsing;
- timeout: 30 seconds maximum;
- worker stdout/stderr: 256 KiB / 32 KiB cumulative;
- trusted result: 48 KiB and at most 200 findings;
- cancellation/timeout/protocol failure: detached process-group SIGTERM, then bounded SIGKILL escalation.

Current limitations remain explicit: process groups guarantee descendant cleanup but are not aggregate memory/PID containment. Node old-space limits do not cover every native/external allocation. Safe syntax budgets are portable workload bounds for a stable local worktree, not a filesystem security sandbox against concurrent mutation. Strict requests therefore remain unavailable until a real cgroup/container/job adapter enforces aggregate limits.
