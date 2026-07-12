# Effect P0 inventory

This is a point-in-time inventory, not an approval list. It covers `Effect.runPromise`, `Effect.runSync`, `Effect.runFork`, `NodeRuntime.runMain`, and `Effect.sync` sites in tracked `.pi/extensions`, `src`, `scripts`, `setup`, and `.agents` source. P3 owns compatibility runner consolidation, P4 owns resource/lifecycle hardening, and P6 owns migration of expected-fallible synchronous work out of `Effect.sync`.

## Compatibility runner boundaries

- `.pi/extensions/pi-update/workflow.ts`: `Effect.runPromise` in `preparePiUpdate` Promise compatibility wrapper.
- `.pi/extensions/subagent/index.ts`: `Effect.runPromise` while waiting for async jobs from the tool boundary.
- `.pi/extensions/subagent/jobs.ts`: `Effect.runPromise` for `wait`/`shutdown` Promise wrappers; `Effect.runFork` for job execution and cancellation fibers.
- `.pi/extensions/subagent/execute.ts`: `Effect.runPromise` for subagent tool compatibility wrappers.
- `.pi/extensions/ptc/executor.ts`: `Effect.runPromise` around scoped temp-script/subprocess execution.
- `.pi/extensions/_shared/node-bin.ts`: `Effect.runPromise` for the Node-binary lookup compatibility wrapper.
- `.pi/extensions/_shared/agent-settings.ts`: `Effect.runSync` for synchronous agent-settings compatibility.
- `.pi/extensions/analyze/worker-main.ts`: `Effect.runPromise` at worker protocol boundaries.
- `src/analyze/supervisor.ts`: `Effect.runPromise` at supervisor/diagnostics protocol boundaries.
- `setup/configure.mjs`: top-level `Effect.runPromise(configureEffect())` setup CLI boundary.
- Test-only `Effect.runPromise` sites are grouped in `.pi/extensions/**/__tests__/*.ts` and `src/analyze/__tests__/*.ts`; they execute Effect APIs under Vitest and are not production boundaries.
- No `NodeRuntime.runMain` sites were present.

## `Effect.sync` sites by classification

Each site is listed once under its primary role.

### Deterministic mutation

- `.pi/extensions/subagent/jobs.ts:160`: non-throwing unit acquisition for the job lifecycle.
- `.pi/extensions/analyze/worker-main.ts:121`: synchronous diagnostic event emission at the isolated worker protocol boundary.
- `setup/policy-effect.mjs:5`: pure setup-policy derivation from environment data.
- `setup/terminal-config.mjs:47`: Ghostty directory capability probe that catches filesystem failure and returns a boolean.

### Lifecycle cleanup

- `.pi/extensions/subagent/jobs.ts:165,186`: interruption status mutation, durable finalization, waiter resolution, slot release, and repump.
- `.pi/extensions/ptc/executor.ts:72`: best-effort subprocess termination during scoped release.
- `.pi/extensions/ptc/node-runtime.ts:60`: best-effort temp-script unlink cleanup.

### Test scaffolding

- `.pi/extensions/subagent/__tests__/persistence.test.ts:85,107,114,134`: listener cleanup and concurrency bookkeeping for fake runners.
- `src/analyze/__tests__/diagnostics.test.ts:131`: fake diagnostics sink mutation.

### Expected-fallible work / P6 migration debt

These are synchronous filesystem or shell operations inside `Effect.sync`; they can throw and should migrate to typed `Effect.try` where appropriate.

- `setup/file-ops.mjs:19`: bootstrap directory creation and file copying.
- `setup/file-ops.mjs:31`: symlink inspection, replacement, and creation.
- `setup/file-ops.mjs:55`: destination reads, directory creation, and file appends.
- `setup/repo-tools.mjs:26`: synchronous `git` command execution.
- `setup/repo-tools.mjs:30`: git-hook directory, symlink, and `chmod` operations.
- `setup/terminal-config.mjs:20`: tmux configuration reads and writes.
- `setup/pi-config.mjs:17`: Pi agent/test directory creation.
- `setup/pi-config.mjs:35`: managed-settings subprocess execution.

## Empty areas

- No `.agents` `Effect.sync` sites were present.
- No `scripts` `Effect.sync` or compatibility runner sites were present outside tests/checker code in this inventory scope.
