# Quality gate repair handoff

Base commit: `ff22869`

## Changes

- Split posting preflight, pending-attempt recording, final submission validation, and submission completion into named helpers while retaining the existing partitioned-semaphore critical section and generation checks.
- Split exact raw provenance record validation into format, size, digest, and identity checks.
- Isolated provenance record identity validation while retaining complete, duplicate-free, exactly-once set accounting and fixed artifact identity checks.
- Split pinned-diff anchor traversal into hunk parsing, metadata recognition, line matching, and line-position advancement while retaining the existing verified-diff read and bounded context slice.
- Corrected `docs/review.md` to state that impact and severity are machine recommendations for new decision-enabled runs and that posting requires an explicit human selection decision.

## Validation

- `nub run quality:changed` — passed (informational pre-existing async-risk findings only).
- `nub run test:vitest --maxWorkers=1 .pi/extensions/review/__tests__` — 16 files, 125 tests passed.
- `nub run typecheck` — passed.
- Language-server diagnostics for all four refactored TypeScript files — no errors.
- Touched-file `oxfmt` — passed.
- `git diff --check` — passed.

No new tests were added. No push, merge, live call, or full safe-suite run was performed.
