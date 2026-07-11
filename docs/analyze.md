# Analyze

`nub run analyze -- --diff` runs the consolidated, deterministic TypeScript analysis. `--all` or explicit paths select other scopes; diff scope combines merge-base-to-HEAD, staged, unstaged, and untracked changes and attributes node findings by hunk intersection.

Output is compact TSV by default. Use `--pretty` or `--json`, `--profile`, `--checks complexity,duplicates,types,async-risk,eslint,dependencies,knip,bundle`, `--bundle`, `--type-threshold 0.8`, `--fail-on never|warning|error` (or `--ci`), and `--ref <git-ref>`. Unknown check names are reported as configuration failures with the valid names. The default diff ref is `main`; explicit directory paths are expanded recursively. `--bench file.json` accepts `{ "command": "...", "args": [], "cwd": "...", "timeoutMs": 30000, "warmups": 1, "runs": 3 }`; commands use `execFile`, never a shell. Bundle analysis is opt-in.

The internal analyzers share one TypeScript Program/TypeChecker. Type-aware ESLint intentionally creates a separate parser/program graph imposed by ESLint; every structured message from `no-floating-promises`, `no-misused-promises`, and `await-thenable` is normalized. Dependency-cruiser uses JSON output. Knip headings are warning-level advisories; unstructured fallback output is explicitly labeled as a legacy adapter. All subprocesses use `execFile`, never a shell. Bundle analysis uses esbuild in-memory output plus its metafile and remains opt-in (`--bundle` or an explicit `bundle` check).

Result JSON is versioned. IDs include the analyzer, message, primary location, and related locations. Timings appear only with `--profile`. Analyzer and benchmark failures are retained alongside successful findings.

## Memory-bounded operation (4 GB hosts)

Analysis resolves scope and checks before loading TypeScript. A TypeScript Program is created only for
`complexity`, `duplicates`, `types`, and `async-risk`, then released before external tools run. ESLint
still uses its typed tsconfig configuration, but derives scoped filenames directly from tsconfig.

RSS guards default to 3072 MiB (`--max-memory-mb`, a positive integer). They run around analyzers and before every bundle entry. If crossed, the result contains an analyzer failure, keeps completed findings, and skips remaining expensive work. These checks are guards, not an OS memory guarantee.

For a safe whole-extension bundle audit, use:

```sh
nub run analyze -- --all --checks bundle --max-memory-mb 3072
```

For a targeted extension audit, pass the extension index path (for example `.pi/extensions/dev-tools/index.ts`). Bundle analysis builds exactly one entrypoint per esbuild invocation, sequentially, and reads `pi-build.config.json#externals` once per run so each build sees the configured externals list and avoids pulling peer/runtime packages into memory. If the config is missing or invalid, the finding data records that no configured externals were available. `--profile` adds stage timings, memory snapshots, and peak RSS/heap/external values to JSON/results; these fields are omitted otherwise. Duplicate and type similarity candidate/comparison/finding limits are explicit, and truncation is reported informationally.
