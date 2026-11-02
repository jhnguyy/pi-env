# Testing

Tests make boundaries of responsibility visible. They describe what a module promises to callers, what it expects from collaborators, and how an interaction may succeed, fail, or stop. Those boundaries give other modules stable places to connect and give a reader a way to understand the target's specifications.

A test makes part of that specification executable. It provides evidence for a promise. A useful suite lets a reader follow the meaningful chains of outcomes across the module's responsibility without having to reconstruct its implementation.

## Caller boundary: prove the promised result

Begin with what the caller should be able to rely on. Expectations should come from that contract. If completion, cancellation, or recovery has no clear meaning, resolve the design question rather than letting a fixture invent the answer.

Success is only one outcome. Invalid input, conflicting state, interrupted work, and partial failure may change what callers can safely do next. A failure before an external effect is different from losing confirmation after it may have happened. Tests should expose that distinction where it affects retries, recovery, or ownership.

Assert the whole consumer-visible result, including required content and failure information, rather than only an intermediate signal. A recorded call shows that a request arrived, not that its result was used. A cancellation signal does not show that work stopped. Valid metadata does not show that useful tool output reached the model. For bounded output, proving that truncation happened is not enough; the promised useful portion must survive.

Name a test for what its assertions prove, not a broader outcome implied by its setup. Demonstrate that a new or replacement check fails when its target contract is violated; a passing run alone does not establish that the check detects the defect.

## Collaboration boundary: choose and corroborate evidence

A workflow test can reveal broken collaboration between otherwise correct modules. A focused test can make a large space of policy decisions or a rare failure cheaper and clearer to exercise. Neither is inherently sufficient or superior. Choose the boundary that exposes the relevant defect without constructing unrelated parts of the application.

Use small, deterministic examples for mechanically decidable functional behavior. Do not derive unit-test fixture sizes from available machine capacity. Capacity and stress qualification need separate selection and measured evidence; a large input alone does not explain a useful contract. Small fixtures and low concurrency do not establish memory containment.

Keep inexpensive, deterministic collaborators real when that strengthens the evidence. Substitute external services, credentials, nondeterminism, or hard-to-induce failures at a meaningful boundary. Corroborate a double's assumptions with a contract test, sandbox run, or recorded response from the real dependency, and explain what the double cannot establish. Upstream evidence can support those assumptions but does not prove this repository's integration. Retain real-adapter evidence where compatibility or lifecycle behavior depends on it. A fake provider can control inference while real SDK sessions and tools establish local integration; it cannot establish hosted-provider compatibility.

## Coverage boundary: preserve distinct contracts

Revisit the test architecture when the production design or verification strategy changes. Before adding cases, review existing scenarios, fixtures, and coverage boundaries as a whole. Decide which tests or suites need to be rewritten or replaced to express the new architecture. Carry forward relevant contracts and failure cases, retire obsolete assumptions, and integrate new cases into a coherent suite.

Compare tests by the responsibilities and failures they expose, not by test count. Similar-looking tests may protect different permissions, failure stages, or recovery behavior. Consolidation should preserve those distinctions; additional coverage should answer a distinct question. In particular, permission, integrity, persistence, cancellation, and lifecycle failures can have similar visible outcomes without protecting the same contract.

Before deleting coverage for a current contract, demonstrate that the replacement evidence catches the same contract violations. Retire checks only when their requirements are obsolete or their protection is demonstrably retained elsewhere.

## Scenario boundary: make outcomes reproducible

Keep scenarios independently understandable. Parameterization helps when inputs vary within the same workflow; separate scenarios often explain different workflows better. Shared setup can reduce expensive initialization, but shared mutable state can hide order dependence.

Control incidental time and randomness when they obscure the result. Use real conditions when those conditions are the behavior under test. Explicit readiness and completion signals are stronger than elapsed-time assumptions. A watchdog bounds a stalled test; it is not evidence that the expected outcome occurred.

Reproduce a reported failure when practical before changing the code, and work through new expectations early enough to influence the design. Keep regression tests for current contracts; leave temporary catching tests and diagnostic experiments uncommitted.

Keep enough evidence to reproduce and assess the result. CI output is often sufficient; retain additional artifacts when they clarify the outcome, following the target project's privacy and storage policy.

## Resource boundary: observe ownership and cleanup

Own resources from allocation through cleanup, including failed startup and assertions. Attempt independent releases, preserve useful failures, and observe results after cleanup settles.

Account for startup, child processes, native allocations, and retained state when choosing execution resources. Measure consequential changes and isolate workloads with uncertain demands. Include runtime artifacts and dynamic inputs when selecting evidence for a change.

For Effect-specific runtime and test services, see [Effect guidance](effect-guardrails.md#tests). For pi-env commands and operating constraints, see [contribution guidance](../../CONTRIBUTING.md#verification).
