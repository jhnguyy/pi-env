---
name: refactor
disable-model-invocation: true
description: Assess evidence-backed refactor opportunities, module seams, and test and migration impact. Use when asked to find structural improvements or evaluate a refactor candidate.
---

# Refactor

Assess opportunities without changing code. An assessment is not implementation authorization.

## Establish the design problem

Read repository instructions and establish the review scope. Trace representative workflows through owners, callers, data, tests, and dependencies, using language-aware navigation when available. Reuse the domain terms in code and documentation.

Connect each candidate to inspected evidence and a current cost: repeated caller coordination, exposed sequencing or state, scattered policy, unclear resource ownership, or changes that require reconstructing one behavior across many modules. Test friction can reveal these problems, but distinguish production ownership issues from fixture limitations. Similar names, file size, or hypothetical reuse alone do not establish a design problem. Finding no worthwhile refactor is a valid result.

State what callers need to accomplish, what they must know today, and what evidence would show an improvement. Separate observed behavior from assumptions and proposed checks.

## Compare responsibilities and interfaces

Identify the responsibility and its natural owner before proposing a seam. Inspect nearby modules and available dependencies for existing capabilities. Keep policy near the workflow and data it governs, and keep state transitions, resource lifecycle, and error handling with the owner that has the authority and information to manage them.

Evaluate interface depth by the capability and coordination hidden from callers relative to the knowledge they still need. A useful interface lets callers express intent without reconstructing internal sequencing, representation, or recovery. Line counts and interface-to-implementation ratios do not measure that benefit. Make required authority, inputs, outcomes, and failures explicit while hiding decisions callers should not own.

Use dependency characteristics to inform the boundary rather than prescribe a layer: direct in-process calls may preserve locality; protocols or deployment boundaries may warrant adapters; substitution may help testing or migration. An abstraction should improve production use and ownership, not exist only to accommodate mocks. Keep cohesive behavior together and preserve distinctions that carry different authority, lifecycle, or failure contracts.

Compare credible alternatives, including leaving the design unchanged, simplifying within the current owner, extending an existing capability, or moving responsibility behind a new interface. Weigh caller knowledge, locality, coupling, operational cost, and migration risk against the observed problem. Recommend the smallest change whose benefit justifies those costs, and identify evidence that could change the recommendation.

## Establish preservation and migration evidence

Identify affected callers and the contracts that must remain true, including relevant permissions, data integrity, persistence, readiness, completion, cancellation, and resource release. Distinguish intentional behavior changes from structural changes so preservation claims remain testable.

Propose functional vertical slices: each should preserve or deliver one observable behavior through the responsibilities needed to establish it, rather than moving every layer before anything can be checked. A slice can end at a meaningful internal seam; it need not cross every deployment boundary. Identify baseline evidence, affected-call-site checks, compatibility needs, and the evidence required before switching or removing an old path. Account for partial migration, rollback, and temporary-path removal; treat uncertain preservation and big-bang migration as design costs.

## Report the assessment

Report supported opportunities without a candidate quota or mandatory template. Give the affected owners and callers, observed cost, alternatives and tradeoffs, recommended responsibility and interface, preservation and migration evidence, and remaining uncertainties. Distinguish proposed verification from completed checks.

Keep the assessment in the response unless a durable artifact is requested or required by local policy. Before creating one, load the local notes or storage adapter and follow its conventions. Ask if the destination is unclear. Capture the selected decision and follow-up work rather than duplicating the exploration.
