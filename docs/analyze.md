# Analyze

`nub run analyze -- --diff` runs the consolidated, deterministic TypeScript analysis. `--all` or explicit paths select other scopes; diff scope combines merge-base-to-HEAD, staged, unstaged, and untracked changes and attributes node findings by hunk intersection.

Output is compact TSV by default. Use `--pretty` or `--json`, `--profile`, `--checks complexity,duplicates,types,async-risk,eslint,dependencies,knip,bundle`, `--bundle`, `--type-threshold 0.8`, `--fail-on never|warning|error` (or `--ci`), and `--ref <git-ref>`. Unknown check names are reported as configuration failures with the valid names. The default diff ref is `main`; explicit directory paths are expanded recursively. `--bench file.json` accepts `{ "command": "...", "args": [], "cwd": "...", "timeoutMs": 30000, "warmups": 1, "runs": 3 }`; commands use `execFile`, never a shell. Bundle analysis is opt-in.

Internal analyzers request the least expensive shared project capability they need. Complexity and async-risk parse only scoped source files, duplicates parses the source corpus without building a semantic graph, and type similarity upgrades the shared project to a TypeScript Program/TypeChecker. Type-aware ESLint intentionally creates a separate parser/program graph imposed by ESLint; every structured message from `no-floating-promises`, `no-misused-promises`, and `await-thenable` is normalized. Dependency-cruiser uses JSON output. Knip headings are warning-level advisories; unstructured fallback output is explicitly labeled as a legacy adapter. All subprocesses use `execFile`, never a shell. Bundle analysis uses esbuild temporary on-disk output plus its metafile and remains opt-in (`--bundle` or an explicit `bundle` check).

Result JSON is versioned. IDs include the analyzer, message, primary location, and related locations. Timings appear only with `--profile`. Analyzer and benchmark failures are retained alongside successful findings.

## Effect and cancellation boundaries

`analyzeEffect` is the typed core: configuration, scope, and project setup failures remain in its Effect error channel. `analyze` is the reporting boundary and exhaustively converts those errors into the existing `AnalysisResult` failure shape. Analyzer dispatch catches synchronous analyzer and parser exceptions as typed `AnalyzerRunError` values; external analyzer and benchmark failures are captured individually so earlier findings and benchmark records survive.

ESLint, dependency-cruiser, Knip, and benchmarks share an argument-array subprocess Effect seam. It aborts child processes on fiber interruption and uses explicit defaults (120 seconds for analyzers, 30 seconds for benchmark commands); timeout and process-exit failures are typed. Node analyzer children inherit the environment and receive a conservative heap cap based on remaining budget after parent RSS and 512 MiB headroom, capped at 1024 MiB; existing `NODE_OPTIONS` are preserved. Esbuild's JS API is non-cancellable, so bundle builds intentionally have no timeout wrapper that could abandon work and overlap a later stage.

## Memory-bounded operation (4 GB hosts)

Analysis resolves scope and checks before loading TypeScript. A declarative analyzer registry plans one shared project capability: scoped syntax for complexity/async-risk, corpus syntax for duplicates, or a semantic Program/TypeChecker when type similarity is selected. The project is released before external tools run. ESLint still uses its typed tsconfig configuration, but derives scoped filenames directly from tsconfig.

RSS guards default to 2048 MiB (`--max-memory-mb`, a positive integer). They run around analyzers and before every bundle entry. If crossed, the result contains an analyzer failure, keeps completed findings, and skips remaining expensive work. These checks are guards, not an OS memory guarantee, and they do not measure or guarantee full process-tree RSS.

For a safe whole-extension bundle audit, use:

```sh
nub run analyze -- --all --checks bundle --max-memory-mb 2048
```

For a targeted extension audit, pass the extension index path (for example `.pi/extensions/dev-tools/index.ts`). Bundle analysis builds exactly one entrypoint per esbuild invocation, sequentially, and reads `pi-build.config.json#externals` once per run so each build sees the configured externals list and avoids pulling peer/runtime packages into memory. Async-risk findings about sequential awaits are review signals, not automatic defects: benchmark runs, analyzer stages, and bundle entries intentionally remain sequential where concurrency would distort measurements or increase peak memory. If the config is missing or invalid, the finding data records that no configured externals were available. `--profile` adds stage timings, memory snapshots, and peak RSS/heap/external values to JSON/results; these fields are omitted otherwise. Duplicate and type similarity candidate/comparison/finding limits are explicit, global finding materialization is capped, and truncation is reported informationally or through analyzer-failure metadata rather than silently dropped.

Safe defaults in this pass:
- parent RSS guard: 2048 MiB
- child Node heap cap: remaining guarded memory after parent RSS and 512 MiB headroom, at most 1024 MiB
- analyzer subprocess timeout: 120s
- benchmark timeout default/max: 30s / 300s
- benchmark warmups max: 10
- benchmark runs max: 100
- explicit path discovery cap: 50,000 analyzable files
- global result finding cap: 2,000

Current limitations remain explicit: esbuild is used through its non-cancellable in-process API, and the RSS guard is not process-tree accounting. Child heap caps limit Node old-space but do not supervise arbitrary descendants or all child memory.
