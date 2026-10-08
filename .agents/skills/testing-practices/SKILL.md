---
name: testing-practices
description: Designs E2E-first tests and repeatable evidence. Use when adding or reviewing tests, fixing a regression, deciding whether isolated tests are necessary, or choosing what a test double may replace.
---

# Testing Practices

Read the repository testing policy and requirements.

1. **Start with E2E.** Exercise the workflow people use and check its final result. Prefer this as the only behavioral test layer. Reuse existing coverage when it already proves the outcome.
2. **Leave evidence where reviewers look.** Each run produces an inspectable record with inputs, expected and actual results, and instructions to reproduce and check it. When CI can run the check, the CI run is that record: make each result visible in the job log or an uploaded artifact. Keep local artifacts for checks that CI cannot run. Preserve failure evidence and follow local privacy and storage policy.
3. **Use isolation only for a named gap.** Explain what E2E cannot exercise reliably. List failure modes and expected outcomes, then write failing tests before the corresponding production code. For existing code, reproduce the failure before changing it. Derive expectations from requirements, not implementation details.
4. **Replace only what the test cannot run.** Run local, deterministic components for real with synthetic data. These include binaries, files, parsers, and in-process services. Use a test double only for:
   - an external service, a credential, real time, or randomness;
   - a failure that you cannot induce otherwise, such as a timeout or a 5xx response.

   Replace at the outermost boundary, such as the HTTP session, a local server, or an adapter port, not at the code's own internal methods. Assert on results and on what crossed the boundary, not on the calls a double received. Every double encodes an assumption about the real dependency. Name the check that confirms that assumption: a contract test, a sandbox run, or a recorded response. Label characterization tests of third-party code as change detectors. Their expectations come from the current implementation.
